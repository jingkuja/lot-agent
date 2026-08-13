import { Hono } from "hono";
import { estimateCost } from "@lot-agent/core";
import type { AgentService } from "../services/agent-service.js";
import { pickGenerationSettings, pickVideoReferenceInputs } from "../generation/input.js";

const ALLOWED_TYPES = ["image.generate", "video.generate"] as const;

/**
 * Whitelist the client task input to business fields only. Identity fields
 * (assistantMessageId/conversationId/userId) are server-owned — a forged
 * assistantMessageId would let the worker overwrite another user's message.
 * This standalone task API creates no message, so none of them belong here.
 */
export function sanitizeTaskInput(
  type: (typeof ALLOWED_TYPES)[number],
  raw: Record<string, unknown> | undefined
): Record<string, unknown> {
  const mediaType = type === "image.generate" ? "image" : "video";
  const input: Record<string, unknown> = pickGenerationSettings(mediaType, raw);
  if (typeof raw?.prompt === "string") input.prompt = raw.prompt;
  if (typeof raw?.modelId === "string") input.modelId = raw.modelId;
  if (Array.isArray(raw?.media)) {
    if (mediaType === "video" && raw.media.filter((m) => (m as { type?: unknown })?.type === "reference_image").length > 5) {
      throw new Error("input_reference supports at most 5 references");
    }
    input.media = raw.media;
  }
  if (mediaType === "video") Object.assign(input, pickVideoReferenceInputs(raw));
  return input;
}

type Variables = { userId: string };

export function createTaskRoutes(service: AgentService) {
  const app = new Hono<{ Variables: Variables }>();

  // POST / — enqueue a new task
  app.post("/", async (c) => {
    const userId = c.get("userId");
    let body: { type?: string; input?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { type, input } = body;

    if (!type || !(ALLOWED_TYPES as readonly string[]).includes(type)) {
      return c.json(
        { error: `Invalid type. Must be one of: ${ALLOWED_TYPES.join(", ")}` },
        400
      );
    }

    let safeInput: Record<string, unknown>;
    try {
      safeInput = sanitizeTaskInput(
        type as (typeof ALLOWED_TYPES)[number],
        input as Record<string, unknown> | undefined
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "invalid task input" }, 400);
    }

    // Quota pre-check: estimate cost via the shared billing source of truth.
    let estimatedCost = 0;
    if (type === "image.generate") {
      const cfg = service.modelRegistry.getConfig("gpt-image-2");
      estimatedCost = cfg ? estimateCost(cfg, { outputCount: 1 }) : 0;
    } else if (type === "video.generate") {
      const cfg = service.modelRegistry.getConfig("kling-standard");
      const durationSec = (safeInput.durationSec as number | undefined) ?? 5;
      estimatedCost = cfg ? estimateCost(cfg, { outputCount: durationSec }) : 0;
    }
    const quota = await service.usageMeter.checkQuota(userId, estimatedCost);
    if (!quota.ok) {
      return c.json({ error: quota.reason, estimatedCost }, 402);
    }

    const jobId = await service.jobQueue.enqueue(type, safeInput, userId);
    return c.json({ jobId }, 202);
  });

  // POST /:id/cancel — request cancellation, ownership check. The DB task row
  // flips to 'cancelled' immediately (state-machine-guarded, so a slower
  // worker's success/failure can't overwrite it); the worker observes the row
  // between polls and stops. Terminal tasks report ok:false + current status.
  app.post("/:id/cancel", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const job = await service.jobQueue.get(id);
    if (!job || (job as unknown as { userId?: string }).userId !== userId) {
      return c.json({ error: "Task not found" }, 404);
    }
    const changed = await service.jobQueue.cancel(id);
    if (changed) {
      // Reflect the cancel on the linked chat message right away (a job that
      // never starts — cancelled while queued — has no worker to do it).
      // Ids come from the task input, which only the server writes.
      const input = job.input as { assistantMessageId?: string; conversationId?: string };
      if (input?.assistantMessageId && input?.conversationId) {
        await service.db.markMessageGenerationCancelled(input.assistantMessageId, {
          conversationId: input.conversationId,
          userId,
        });
      }
    }
    return c.json({ ok: changed, status: changed ? "cancelled" : job.status });
  });

  // GET /:id — poll task status, ownership check
  app.get("/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const job = await service.jobQueue.get(id);
    if (!job) {
      return c.json({ error: "Task not found" }, 404);
    }
    // Ownership check — job.userId may or may not exist depending on JobQueue impl
    if ((job as unknown as { userId?: string }).userId && (job as unknown as { userId?: string }).userId !== userId) {
      return c.json({ error: "Task not found" }, 404);
    }
    return c.json(job);
  });

  return app;
}

import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

const ALLOWED_TYPES = ["image.generate", "video.generate"] as const;

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

    // Quota pre-check: estimate cost based on model unitPrice
    let estimatedCost = 0;
    if (type === "image.generate") {
      const modelId = "wanx-standard";
      estimatedCost = (service.modelRegistry.getConfig(modelId)?.unitPrice ?? 0) * 1;
    } else if (type === "video.generate") {
      const modelId = "kling-standard";
      const durationSec = (input as Record<string, unknown>)?.durationSec as number | undefined ?? 5;
      estimatedCost = (service.modelRegistry.getConfig(modelId)?.unitPrice ?? 0) * durationSec;
    }
    const quota = await service.usageMeter.checkQuota(userId, estimatedCost);
    if (!quota.ok) {
      return c.json({ error: quota.reason, estimatedCost }, 402);
    }

    const jobId = await service.jobQueue.enqueue(type, input ?? {}, userId);
    return c.json({ jobId }, 202);
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

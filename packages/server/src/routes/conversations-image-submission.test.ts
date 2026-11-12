import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { AgentService } from "../services/agent-service.js";
import { createGenerationRoutes } from "./conversations.js";

function setup() {
  const metadata = new Map<string, Record<string, unknown>>();
  const db = {
    getConversation: vi.fn(async () => ({ user_id: "owner", agent_id: "image" })),
    claimConversationRun: vi.fn(async () => true),
    releaseConversationRun: vi.fn(async () => {}),
    getImageSubmission: vi.fn(async (_conversationId: string, requestId: string) => {
      for (const [id, value] of metadata) {
        if (value.requestId === requestId) return { id, metadata: value };
      }
      return null;
    }),
    getGeneratedByStorageKey: vi.fn(async () => ({ user_id: "owner", mime: "image/png", is_private: true })),
    addMessage: vi.fn(async (id: string, _conversationId: string, _role: string, _content: string, options?: {
      metadata: Record<string, unknown>;
    }) => { if (options) metadata.set(id, options.metadata); }),
    updateMessageGeneration: vi.fn(async (id: string, patch: { metadata: Record<string, unknown> }) => {
      metadata.set(id, { ...patch.metadata, submissionTaskId: patch.metadata.taskId });
    }),
  };
  const enqueue = vi.fn(async () => "image-task");
  const quota = vi.fn<() => Promise<{ ok: boolean; reason?: string }>>(async () => ({ ok: true }));
  const service = {
    db,
    modelRegistry: { getConfig: () => undefined },
    modelCatalog: { pricing: {}, defaultPricing: {} },
    usageMeter: { checkQuota: quota },
    generationSupportsProgress: { image: false },
    jobQueue: { enqueue },
  } as unknown as AgentService;
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "owner"); await next(); });
  app.route("/conversations", createGenerationRoutes(service));
  const submit = () => app.request("/conversations/chat/generations", {
    method: "POST",
    body: JSON.stringify({
      mediaType: "image", prompt: "change the background", requestId: "image-submission-1",
      media: [{ type: "reference_image", url: "/static/assets/source.png?token=temporary" }],
    }),
  });
  return { submit, db, enqueue, quota };
}

it("persists the owned source without a temporary token and replays the accepted task", async () => {
  const { submit, db, enqueue } = setup();
  const first = await submit();
  expect(first.status).toBe(202);
  const receipt = await first.json() as { taskId: string; userMessage: { id: string; metadata: unknown } };
  const imageInput = { scene: "free", realText: false, references: [{ url: expect.stringMatching(/\/source\.png$/), kind: "output" }] };
  expect(receipt.userMessage.metadata).toMatchObject({ imageInput });
  expect(db.addMessage.mock.calls[0][4]?.metadata).toMatchObject({ imageInput });
  const retry = await submit();
  expect(retry.status).toBe(202);
  expect(await retry.json()).toMatchObject({
    taskId: receipt.taskId, userMessage: { id: receipt.userMessage.id, metadata: { imageInput } },
  });
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(db.addMessage).toHaveBeenCalledTimes(2);
});

it("allows the draft to be submitted after a quota rejection", async () => {
  const { submit, db, enqueue, quota } = setup();
  quota.mockResolvedValueOnce({ ok: false, reason: "余额不足" });
  expect((await submit()).status).toBe(402);
  expect(db.addMessage).not.toHaveBeenCalled();
  expect((await submit()).status).toBe(202);
  expect(enqueue).toHaveBeenCalledTimes(1);
});

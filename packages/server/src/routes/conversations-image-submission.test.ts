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
    getGenerationMessage: vi.fn<() => Promise<{ status: string; metadata: Record<string, unknown> } | null>>(async () => null),
    getTask: vi.fn(async () => null),
    findOriginalImageTask: vi.fn<() => Promise<{ id: string; input: Record<string, unknown> } | null>>(async () => null),
    updateGenerationMetadata: vi.fn(async () => true),
    resetGenerationForRedownload: vi.fn(async () => true),
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
  return { app, submit, db, enqueue, quota };
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

it("looks up a submission without creating or claiming anything and isolates the owner", async () => {
  const { app, submit, db, enqueue } = setup();
  const lookup = () => app.request("/conversations/chat/generations/submissions/image-submission-1");
  expect((await lookup()).status).toBe(409);
  expect(db.claimConversationRun).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
  await submit();
  expect(await (await lookup()).json()).toMatchObject({ taskId: "image-task" });
  expect(enqueue).toHaveBeenCalledTimes(1);
  db.getConversation.mockResolvedValueOnce({ user_id: "someone-else", agent_id: "image" });
  expect((await lookup()).status).toBe(404);
});

it("blocks paid fill-in when an image slot has an unknown result", async () => {
  const { app, db, enqueue } = setup();
  db.getGenerationMessage.mockResolvedValue({ status: "completed", metadata: {
    kind: "generation", mediaType: "image", scene: "product_set", status: "completed", unknownResult: true,
    assets: [{ url: "/static/assets/main.png" }], missing: 1, taskId: "original",
  } });
  const response = await app.request("/conversations/chat/generations/message/redo", {
    method: "POST", body: JSON.stringify({ missing: true }),
  });
  expect(response.status).toBe(409);
  expect(enqueue).not.toHaveBeenCalled();
});


it("regenerates a single image with its frozen prompt and model and replays the same fresh submission", async () => {
  const { app, db, enqueue } = setup();
  db.getGenerationMessage.mockResolvedValue({ status: "completed", metadata: {
    kind: "generation", mediaType: "image", scene: "white_background", status: "completed", prompt: "杯子白底图",
    assets: [{ url: "/static/assets/original.png" }], taskId: "download-only",
  } });
  db.findOriginalImageTask.mockResolvedValue({ id: "original", input: {
    prompt: "Frozen white-background prompt", scene: "white_background", modelId: "linqu-image", size: "1024x1024", quality: "high",
  } });
  const send = () => app.request("/conversations/chat/generations", {
    method: "POST", body: JSON.stringify({ mediaType: "image", regenerateFrom: "10000000-0000-4000-8000-000000000001", requestId: "regenerate-attempt-1" }),
  });
  expect((await send()).status).toBe(202);
  expect((await send()).status).toBe(202);
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledWith("image.generate", expect.objectContaining({
    prompt: "Frozen white-background prompt", modelId: "linqu-image", size: "1024x1024", quality: "high", n: 1, fresh: true,
  }), "owner");
});

it("redoes the selected slot using original set context after a download-only task", async () => {
  const { app, db, enqueue } = setup();
  db.getGenerationMessage.mockResolvedValue({ status: "completed", metadata: {
    kind: "generation", mediaType: "image", scene: "product_set", status: "completed",
    assets: [{ url: "/static/assets/main.png" }, { url: "/static/assets/second.png" }], taskId: "download-only",
  } });
  db.findOriginalImageTask.mockResolvedValue({ id: "original", input: {
    prompts: ["Main shot", "Detail shot"], modelId: "linqu-image", size: "1024x1024",
  } });
  const res = await app.request("/conversations/chat/generations/original-message/redo", {
    method: "POST", body: JSON.stringify({ index: 1, instruction: "拍瓶口特写" }),
  });
  expect(res.status).toBe(202);
  expect(enqueue).toHaveBeenCalledWith("image.set_redo", expect.objectContaining({
    indexes: [1], modelId: "linqu-image", setReference: "/static/assets/main.png",
    prompts: [expect.stringMatching(/^Detail shot[\s\S]+拍瓶口特写$/)],
  }), "owner");
});


it("carries the original task and missing count into a download retry", async () => {
  const { app, db, enqueue } = setup();
  db.getGenerationMessage.mockResolvedValue({ status: "download_failed", metadata: {
    kind: "generation", mediaType: "image", scene: "product_set", status: "download_failed", missing: 2,
    settings: { n: 4 }, taskId: "previous-retry", sourceUrl: "https://images.example/result.png",
  } });
  db.findOriginalImageTask.mockResolvedValue({ id: "original", input: { prompts: ["cover", "feature", "scene", "detail"] } });
  const res = await app.request("/conversations/chat/generations/original-message/redownload", { method: "POST" });
  expect(res.status).toBe(202);
  expect(enqueue).toHaveBeenCalledWith("generation.redownload", expect.objectContaining({
    originalTaskId: "original", missing: 2, n: 4,
  }), "owner");
  expect(db.updateMessageGeneration).toHaveBeenCalledWith("original-message", expect.objectContaining({
    metadata: expect.objectContaining({ originalTaskId: "original", missing: 2 }),
  }), { conversationId: "chat", userId: "owner" });
});

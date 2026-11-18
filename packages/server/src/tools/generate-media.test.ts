import { ToolRegistry } from "@lot-agent/core";
import { describe, expect, it, vi } from "vitest";
import { createDigitalEmployeeExtension, digitalEmployeeAllowedToolNames, DIGITAL_EMPLOYEE_PRIVATE_TOOL_NAMES } from "../digital-employee/agent.js";
import { registerAgentExtension } from "../services/agent-extensions.js";
import type { AgentService } from "../services/agent-service.js";
import { createMediaGenerationTools } from "./generate-media.js";

function setup(agentId = "general", owner = "owner") {
  const db = {
    getConversation: vi.fn(async () => ({ agent_id: agentId, user_id: owner, metadata: { digitalEmployeeFeatureScope: "employee" } })),
    getUserApiKey: vi.fn(async () => "owner-key"),
    createChatGeneration: vi.fn<AgentService["db"]["createChatGeneration"]>().mockResolvedValue(true),
    failUnpublishedChatGeneration: vi.fn().mockResolvedValue(true),
  };
  const catalog = {
    image: [{ id: "gpt-image-2" }, { id: "gpt-image-2.5-flare" }],
    video: [{ id: "kling-video-v3-omni" }, { id: "grok-imagine-video-1.5" }],
  };
  const publish = vi.fn<(id: string, type: string) => Promise<void>>().mockResolvedValue(undefined);
  const validateMediaPrompt = vi.fn().mockResolvedValue(undefined);
  registerAgentExtension(createDigitalEmployeeExtension({ validateMediaPrompt }));
  const checkQuota = vi.fn().mockResolvedValue({ ok: true });
  const service = {
    db, getUserModelCatalog: vi.fn(async () => catalog), managedKeysEnabled: true,
    generationConfig: { image: { modelId: "gpt-image-2" } }, generationSupportsProgress: { image: false, video: true },
    usageMeter: { checkQuota }, modelRegistry: { getConfig: () => undefined },
    modelCatalog: { pricing: {}, defaultPricing: {} },
  };
  const registry = new ToolRegistry();
  for (const tool of createMediaGenerationTools(service as unknown as AgentService, publish)) registry.register(tool);
  const context = { userId: "owner", conversationId: "chat-id", runId: "run-id", workingDirectory: "." };
  const run = (name: string, input: unknown = { prompt: "  a rainy street  " }) => registry.execute(name, input, context);
  return { run, db, catalog, publish, checkQuota, validateMediaPrompt };
}

describe("chat media generation", () => {
  it("queues a Flare 1536×1536 image with a receipt in the general chat", async () => {
    const { run, db, publish } = setup();
    const result = await run("generate_image");
    expect(result.isError).toBeUndefined();
    const [request] = db.createChatGeneration.mock.calls[0];
    expect(request).toMatchObject({
      userId: "owner", conversationId: "chat-id", runId: "run-id", type: "image.generate", model: "gpt-image-2.5-flare",
      job: { prompt: "a rainy street", resolution: "1.5K", size: "1536x1536", ratio: "1:1", n: 1, requireUserModelKey: true },
      metadata: { chatGeneration: true, status: "generating" },
    });
    expect(request.job.assistantMessageId).toBe(request.messageId);
    expect(request.metadata.taskId).toBe(request.taskId);
    expect(JSON.parse(result.content)).toMatchObject({ status: "queued", taskId: request.taskId });
    expect(publish).toHaveBeenCalledWith(request.taskId, "image.generate");
  });

  it("uses the owner's spacebunny model and 720p for standalone digital employee videos", async () => {
    const { run, db, validateMediaPrompt } = setup("digital_employee");
    const toolNames = ["generate_image", "generate_video"];
    expect(digitalEmployeeAllowedToolNames("employee", toolNames)).toEqual(toolNames);
    expect(DIGITAL_EMPLOYEE_PRIVATE_TOOL_NAMES).not.toContain("generate_video");
    expect((await run("generate_video")).isError).toBeUndefined();
    expect(validateMediaPrompt).toHaveBeenCalledWith("owner", "a rainy street");
    expect(db.createChatGeneration).toHaveBeenCalledWith(expect.objectContaining({
      model: "grok-imagine-video-1.5", job: expect.objectContaining({ resolution: "720p", durationSec: 5, ratio: "16:9" }),
    }));
  });

  it("rejects other owners, smuggled settings, and unavailable models or quota before creating a task", async () => {
    const other = setup("general", "other-owner");
    expect((await other.run("generate_image")).errorKind).toBe("permission");
    expect(other.db.getUserApiKey).not.toHaveBeenCalled();
    const { run, db, catalog, checkQuota } = setup();
    expect((await run("generate_image", { prompt: "landscape", assistantMessageId: "forged" })).errorKind).toBe("validation");
    catalog.video.pop();
    expect((await run("generate_video")).errorKind).toBe("permission");
    checkQuota.mockResolvedValueOnce({ ok: false, reason: "余额不足" });
    expect((await run("generate_image")).errorKind).toBe("quota");
    expect(db.createChatGeneration).not.toHaveBeenCalled();
  });

  it("fences late delivery and never re-publishes after an ambiguous queue error", async () => {
    const { run, db, publish } = setup();
    publish.mockRejectedValueOnce(new Error("Redis timeout"));
    expect((await run("generate_video")).isError).toBe(true);
    const [{ taskId, messageId }] = db.createChatGeneration.mock.calls[0];
    expect(db.failUnpublishedChatGeneration).toHaveBeenCalledWith(taskId, messageId, expect.any(String));
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

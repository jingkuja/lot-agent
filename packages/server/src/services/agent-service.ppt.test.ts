import { describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent-service.js";
import { encodePptApproval, PPT_APPROVAL_PREFIX } from "@lot-agent/core/presentation";

function harness(toolNames = ["generate_ppt"]) {
  const execute = vi.fn(async () => ({ content: "下载链接：/static/documents/test.pptx" }));
  const service = Object.create(AgentService.prototype) as AgentService;
  const messageRepo = { saveUserMessage: vi.fn(async () => "user-message"), saveAssistantWithToolCalls: vi.fn(), saveToolResult: vi.fn(), loadHistory: vi.fn() };
  const llm = vi.fn(() => { throw new Error("must not call model"); });
  Object.assign(service, { agentConfig: {}, agentRegistry: { get: () => ({ id: "ppt", toolNames }) }, messageRepo, toolRegistry: { get: () => ({ name: "generate_ppt", execute }) }, providerFactory: { llm } });
  return { service, messageRepo, execute, llm };
}
const deck = { title: "T", themePreset: "warm" as const, slides: [{ layout: "cover" as const, title: "确认的标题" }] };

describe("structured PPT confirmation in the chat flow", () => {
  it("retains exact settings and bypasses history materialization and the LLM", async () => {
    const h = harness();
    const events = [];
    for await (const event of h.service.streamAgentResponse("chat", encodePptApproval(deck), "ppt", "owner")) events.push(event);
    expect(h.execute).toHaveBeenCalledWith(deck, expect.objectContaining({ userId: "owner", conversationId: "chat", sourceMessageId: "user-message" }));
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.messageRepo.loadHistory).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done", totalTokens: 0 });
  });
  it("rejects malformed confirmations instead of treating them as generative prompts", async () => {
    const h = harness();
    await expect(async () => { for await (const _ of h.service.streamAgentResponse("chat", PPT_APPROVAL_PREFIX + "{}", "ppt", "owner")) { /* drain */ } }).rejects.toThrow();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.llm).not.toHaveBeenCalled();
  });
  it("honors the agent tool whitelist", async () => {
    const h = harness(["ask_user"]);
    await expect(async () => { for await (const _ of h.service.streamAgentResponse("chat", encodePptApproval(deck), "image", "owner")) { /* drain */ } }).rejects.toThrow("unavailable");
    expect(h.execute).not.toHaveBeenCalled();
  });
});

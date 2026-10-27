import { beforeEach, describe, expect, it, vi } from "vitest";
import { GROK_MARKETING_PROFILE, MARKETING_REVIEW_MODEL, MarketingDraftSchema, storyboardScript, type MarketingProject } from "@lot-agent/core/marketing-video";
import { MarketingTextError } from "./text.js";
import type { TextOperation } from "./operations.js";
import { MarketingWriting, type MarketingWritingDeps } from "./writing.js";
import { marketingCopyModel } from "./copy-model.js";
import { REVIEW_INSTRUCTION } from "./compliance.js";

// A model failure in one test must not switch the copy model of the next.
beforeEach(() => marketingCopyModel.reset());

const id = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const shots = [1, 2].map(() => ({ durationSec: 15, script: "欢迎来到转角咖啡店，现磨咖啡等你来。", visual: "咖啡店", action: "展示咖啡", camera: "中景" }));
const draft = MarketingDraftSchema.parse({ durationSec: 30, script: storyboardScript(shots), storyboard: shots });
const project = { id, version: 2, draft, taskId: null, status: "draft" } as MarketingProject;
const operation = (status: TextOperation["status"], result?: TextOperation["result"]) => ({ id: requestId, kind: "copy", status, result }) as TextOperation;

function fixture(raw: unknown, begin: { fresh: boolean; operation: TextOperation; input?: unknown } = { fresh: true, operation: operation("running") }) {
  const deps = {
    service: {
      marketingText: vi.fn(async (_system: string, _input: string, _owner: string, _signal: unknown,
        options: { onReceipt?: (r: unknown) => Promise<void> }) => {
        await options.onReceipt?.({ outcome: "completed" });
        if (raw instanceof Error) throw raw;
        return raw;
      }),
    },
    store: { get: vi.fn(async () => project) },
    operations: {
      begin: vi.fn(async () => ({ draft, input: {}, ...begin })),
      receipt: vi.fn(async () => {}),
      finish: vi.fn(async (_owner: string, _id: string, result: TextOperation["result"]) => operation("succeeded", result)),
      fail: vi.fn(async () => {}),
    },
    activeProfile: GROK_MARKETING_PROFILE,
  };
  return { deps, writing: new MarketingWriting(deps as unknown as MarketingWritingDeps) };
}
const request = { clientRequestId: requestId, version: 2, locale: "zh" as const };

describe("marketing text requests", () => {
  it("records the receipt before the result and returns the applied project", async () => {
    const { deps, writing } = fixture({ publishTitle: "转角咖啡", tags: "#咖啡 #探店" });
    const result = await writing.publication("owner", id, { ...request, fillMissing: false });
    expect(deps.operations.begin).toHaveBeenCalledWith("owner", requestId, id, 2, "publication", { version: 2, locale: "zh", fillMissing: false }, undefined, "kimi-k3.1-pro");
    expect(deps.operations.receipt).toHaveBeenCalledWith("owner", requestId, { outcome: "completed" });
    expect(deps.operations.receipt.mock.invocationCallOrder[0]).toBeLessThan(deps.operations.finish.mock.invocationCallOrder[0]);
    expect(deps.operations.finish.mock.calls[0][2]).toMatchObject({ draft: { publishTitle: "转角咖啡", tags: "#咖啡 #探店" } });
    expect(result).toMatchObject({ id, operation: { status: "succeeded" } });
  });
  it("replays a repeated request without another model call", async () => {
    const saved = { draft, analysis: "已保存" };
    const { deps, writing } = fixture(null, { fresh: false, operation: operation("succeeded", saved) });
    const result = await writing.copy("owner", id, { ...request, draft, source: { kind: "text" } });
    expect(deps.service.marketingText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ analysis: "已保存", operation: { status: "succeeded" }, project: { id } });
  });
  it("never pays again for a repeated request without a saved result", async () => {
    const { deps, writing } = fixture(null, { fresh: false, operation: operation("failed") });
    await expect(writing.review("owner", id, request)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("如需重新付费创作") });
    const running = fixture(null, { fresh: false, operation: operation("unknown") });
    await expect(running.writing.storyboard("owner", project, { ...request, instruction: "" })).rejects.toMatchObject({ status: 409 });
    expect(deps.service.marketingText).not.toHaveBeenCalled();
    expect(running.deps.service.marketingText).not.toHaveBeenCalled();
  });
  it("marks a failed call as started, and an invalid answer as invalid output", async () => {
    const gateway = fixture(new MarketingTextError("网关超时", "MARKETING_TEXT_TIMEOUT", 504));
    await expect(gateway.writing.publication("owner", id, { ...request, fillMissing: true })).rejects.toThrow("网关超时");
    expect(gateway.deps.operations.fail).toHaveBeenCalledWith("owner", requestId, true, false);
    const invalid = fixture({ publishTitle: "" });
    await expect(invalid.writing.publication("owner", id, { ...request, fillMissing: false })).rejects.toMatchObject({ code: "MARKETING_TEXT_INVALID_RESULT" });
    expect(invalid.deps.operations.fail).toHaveBeenCalledWith("owner", requestId, true, true);
    expect(invalid.deps.operations.finish).not.toHaveBeenCalled();
  });
  it("releases a storyboard request refused before the model call as not started", async () => {
    const { deps, writing } = fixture({ shots });
    await expect(writing.storyboard("owner", project, { ...request, instruction: "改第三镜", index: 2 })).rejects.toThrow("分镜修改参数无效。");
    expect(deps.service.marketingText).not.toHaveBeenCalled();
    expect(deps.operations.fail).toHaveBeenCalledWith("owner", requestId, false, false);
  });
  it("checks copy on the review model and turns a conflict into a 409", async () => {
    const { deps, writing } = fixture({ verdict: "pass", issues: [] });
    deps.operations.finish.mockResolvedValueOnce(operation("conflict"));
    await expect(writing.review("owner", id, { ...request, locale: "en" })).rejects.toMatchObject({ status: 409, message: "文案已更新，请重新检查。" });
    const [system, , , , options] = deps.service.marketingText.mock.calls[0];
    expect(system).toContain("Write reasons and suggested replacements in en.");
    expect(options).toMatchObject({ model: MARKETING_REVIEW_MODEL });
    expect(options).not.toHaveProperty("upstreamBilling");
  });
  it("starts every check with the same fixed rules, so the gateway can cache them, and logs the cached share", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { deps, writing } = fixture({ verdict: "pass", issues: [] });
      deps.service.marketingText.mockImplementation(async (_system, _input, _owner, _signal, options) => {
        await options.onReceipt?.({ outcome: "completed", usage: { promptTokens: 7000, completionTokens: 20, cachedPromptTokens: 6900 } });
        return { verdict: "pass", issues: [] };
      });
      await writing.review("owner", id, { ...request, locale: "en" });
      deps.operations.begin.mockResolvedValueOnce({ draft, input: { delta: { fields: [{ field: "script" }], carried: [] } }, fresh: true, operation: operation("running") });
      await writing.review("owner", id, request);
      const systems = deps.service.marketingText.mock.calls.map(call => call[0]);
      for (const system of systems) expect(system.startsWith(REVIEW_INSTRUCTION)).toBe(true);
      expect(systems[1]).toContain("Incremental re-check");
      expect(log).toHaveBeenCalledWith("[marketing-video] text usage", { kind: "review", promptTokens: 7000, cachedPromptTokens: 6900, completionTokens: 20 });
    } finally { log.mockRestore(); }
  });
});

import { describe, it, expect, vi } from "vitest";
import { resolveProvider, resolvePricing, enrichCatalog, orderLlmModels, pickBackgroundTaskLlmModel, pickUtilityLlmModel, type ModelCatalogConfig } from "./catalog.js";

const cfg: ModelCatalogConfig = {
  defaultProvider: { llm: "openai", image: "chat-completions", video: "openai-video" },
  // the "veo3.1" video entry exists to prove video resolution IGNORES providerMap.
  providerMap: { "veo3.1": "happyhorse", "gpt-image-2-token": "chat-completions" },
  pricing: { "gpt-image-2-token": { inputPrice: 0, outputPrice: 0, unitPrice: 0.04 } },
  defaultPricing: {
    llm: { inputPrice: 0.001, outputPrice: 0.002, unitPrice: 0 },
    image: { inputPrice: 0, outputPrice: 0, unitPrice: 0.04 },
    video: { inputPrice: 0, outputPrice: 0, unitPrice: 0.5 },
  },
};

describe("catalog resolvers", () => {
  it("llm always resolves to the llm default provider", () => {
    expect(resolveProvider(cfg, "any-unknown-llm", "llm")).toBe("openai");
  });
  it("video always resolves to the video default, ignoring providerMap", () => {
    // veo3.1 is mapped to happyhorse in providerMap, but video ignores the map —
    // every video model routes through the single defaultProvider.video.
    expect(resolveProvider(cfg, "veo3.1", "video")).toBe("openai-video");
    expect(resolveProvider(cfg, "any-dynamic-video", "video")).toBe("openai-video");
  });
  it("image uses providerMap then per-type default", () => {
    expect(resolveProvider(cfg, "gpt-image-2-token", "image")).toBe("chat-completions");
    expect(resolveProvider(cfg, "unknown-image", "image")).toBe("chat-completions");
  });
  it("pricing uses the table then falls back to per-type default", () => {
    expect(resolvePricing(cfg, "gpt-image-2-token", "image").unitPrice).toBe(0.04);
    expect(resolvePricing(cfg, "brand-new-llm", "llm")).toEqual(cfg.defaultPricing.llm);
  });
  it("enrichCatalog builds three typed buckets", () => {
    const out = enrichCatalog(cfg, { llm: ["gpt-5.4"], image: ["gpt-image-2-token"], video: ["veo3.1"] });
    expect(out.llm[0]).toEqual({ id: "gpt-5.4", type: "llm", provider: "openai", pricing: cfg.defaultPricing.llm });
    expect(out.video[0].provider).toBe("openai-video");
  });
  it("puts deepseek-v4.1-flash first while preserving the remaining order", () => {
    const out = enrichCatalog(cfg, {
      llm: ["claude-opus-4.1", "gpt-5.4", "other-llm", "deepseek-v4.1-flash", "qwen3.7-max"],
      image: [],
      video: [],
    });
    expect(out.llm.map((model) => model.id)).toEqual([
      "deepseek-v4.1-flash", "gpt-5.4", "other-llm", "qwen3.7-max", "claude-opus-4.1",
    ]);
  });
  it("stably moves Claude LLMs behind other models before choosing a default", () => {
    const out = enrichCatalog(cfg, {
      llm: ["claude-opus-4.1", "gpt-5.4", "Claude-Sonnet-4.5", "deepseek-v4"],
      image: ["gpt-image-2-token"],
      video: ["veo3.1"],
    });
    expect(out.llm.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "deepseek-v4",
      "claude-opus-4.1",
      "Claude-Sonnet-4.5",
    ]);
    expect(out.image.map((model) => model.id)).toEqual(["gpt-image-2-token"]);
    expect(out.video.map((model) => model.id)).toEqual(["veo3.1"]);
  });
  it.each<[string, boolean, string[], string[]]>([
    ["domestic default first", false,
      ["claude-sonnet-5-5", "gpt-5.4", "deepseek-v4.1-flash", "kimi-k3.1-pro"],
      ["kimi-k3.1-pro", "deepseek-v4.1-flash", "gpt-5.4", "claude-sonnet-5-5"]],
    ["domestic without Kimi", false,
      ["claude-sonnet-5-5", "gpt-5.4", "deepseek-v4.1-flash"],
      ["deepseek-v4.1-flash", "gpt-5.4", "claude-sonnet-5-5"]],
    ["international Claude default first", true,
      ["claude-opus-5-5", "kimi-k3.1-pro", "deepseek-v4.1-flash", "claude-sonnet-5-5", "fable-5.1"],
      ["claude-sonnet-5-5", "deepseek-v4.1-flash", "kimi-k3.1-pro", "claude-opus-5-5", "fable-5.1"]],
    ["international with only Opus", true,
      ["kimi-k3.1-pro", "claude-opus-5-5", "deepseek-v4.1-flash"],
      ["claude-opus-5-5", "deepseek-v4.1-flash", "kimi-k3.1-pro"]],
    ["international without either default", true,
      ["kimi-k3.1-pro", "claude-haiku-5-5", "deepseek-v4.1-flash"],
      ["deepseek-v4.1-flash", "kimi-k3.1-pro", "claude-haiku-5-5"]],
    ["only Claude models keep a usable default", false, ["claude-opus-5-5"], ["claude-opus-5-5"]],
  ])("orders %s", (_name, international, ids, expected) => {
    expect(orderLlmModels(ids.map((id) => ({ id })), international).map((model) => model.id)).toEqual(expected);
  });
  it("follows the deployment mode by default", () => {
    vi.stubEnv("globle", "1");
    const ids = ["kimi-k3.1-pro", "claude-sonnet-5-5"];
    expect(orderLlmModels(ids.map((id) => ({ id }))).map((model) => model.id)).toEqual(["claude-sonnet-5-5", "kimi-k3.1-pro"]);
    vi.unstubAllEnvs();
  });
  it.each<[string[], string | null]>([
    [["claude-sonnet-5-5", "kimi-k3.1-pro", "deepseek-v4.1-flash"], "deepseek-v4.1-flash"],
    [["claude-sonnet-5-5", "fable-5.1", "kimi-k3.1-pro"], "kimi-k3.1-pro"],
    [["claude-sonnet-5-5", "opus-4.8"], null],
    [[], null],
  ])("picks a background model from %j without Claude", (ids, expected) => {
    expect(pickUtilityLlmModel(ids)).toBe(expected);
  });
  it.each<[string[], boolean, string | null]>([
    [["deepseek-v4.1-flash", "kimi-k3.1-pro"], false, "kimi-k3.1-pro"],
    [["deepseek-v4.1-flash", "gpt-6.1-terra"], true, "gpt-6.1-terra"],
    [["deepseek-v4.1-flash", "claude-opus-5-5"], true, "deepseek-v4.1-flash"],
    [["kimi-k3.1-pro"], true, "kimi-k3.1-pro"],
    [["claude-opus-5-5"], false, null],
  ])("picks a task's default from %j", (ids, international, expected) => {
    expect(pickBackgroundTaskLlmModel(ids, international)).toBe(expected);
  });
  it("does not mutate cached model arrays while normalizing their order", () => {
    const input = [{ id: "claude-4" }, { id: "gpt-5.4" }];
    expect(orderLlmModels(input).map((model) => model.id)).toEqual(["gpt-5.4", "claude-4"]);
    expect(input.map((model) => model.id)).toEqual(["claude-4", "gpt-5.4"]);
  });
});

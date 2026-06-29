import { describe, it, expect } from "vitest";
import { makeImageProvider, makeVideoProvider, type GenerationConfig } from "./config.js";
import { MockImageProvider, OpenAIImageProvider, MockVideoProvider, OpenAIVideoProvider } from "@lot-agent/core";

const base: GenerationConfig = {
  baseUrl: "https://api/v1",
  apiKey: "",
  mock: true,
  image: { model: "i", modelId: "wanx-standard" },
  video: { model: "v", modelId: "kling-standard" },
};

describe("provider factory", () => {
  it("mock:true → mock providers", () => {
    expect(makeImageProvider(base)).toBeInstanceOf(MockImageProvider);
    expect(makeVideoProvider(base)).toBeInstanceOf(MockVideoProvider);
  });
  it("mock:false with key → real providers", () => {
    const cfg = { ...base, mock: false, apiKey: "k" };
    expect(makeImageProvider(cfg)).toBeInstanceOf(OpenAIImageProvider);
    expect(makeVideoProvider(cfg)).toBeInstanceOf(OpenAIVideoProvider);
  });
  it("mock:false but no key → falls back to mock", () => {
    const cfg = { ...base, mock: false, apiKey: "" };
    expect(makeImageProvider(cfg)).toBeInstanceOf(MockImageProvider);
  });
});

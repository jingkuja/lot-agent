import { describe, it, expect } from "vitest";
import { makeGenerationProvider } from "./config.js";
import { HttpGenerationProvider, MockGenerationProvider } from "@lot-agent/core";

describe("makeGenerationProvider", () => {
  const base = { baseUrl: "https://api/v1", apiKey: "", mock: true, adapter: "happyhorse", image: { model: "im", modelId: "wanx-standard" }, video: { model: "vm", modelId: "kling-standard" } };
  it("mock:true → MockGenerationProvider", () => {
    expect(makeGenerationProvider(base)).toBeInstanceOf(MockGenerationProvider);
  });
  it("mock:false + key → HttpGenerationProvider", () => {
    expect(makeGenerationProvider({ ...base, mock: false, apiKey: "k" })).toBeInstanceOf(HttpGenerationProvider);
  });
  it("mock:false + no key → falls back to mock", () => {
    expect(makeGenerationProvider({ ...base, mock: false, apiKey: "" })).toBeInstanceOf(MockGenerationProvider);
  });
});

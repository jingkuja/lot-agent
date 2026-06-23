import { describe, it, expect } from "vitest";
import { AppConfigSchema } from "./schema.js";

describe("AppConfigSchema", () => {
  it("rejects config without llm.default", () => {
    expect(() => AppConfigSchema.parse({ llm: {} })).toThrow();
  });
  it("accepts a minimal valid config", () => {
    const cfg = AppConfigSchema.parse({
      llm: { default: "openai", openai: { apiKey: "x", model: "m" }, anthropic: { apiKey: "", model: "m" } },
      agent: { maxIterations: 10, systemPrompt: "hi" },
      mcp: { servers: [] },
      server: { port: 3000, host: "0.0.0.0" },
    });
    expect(cfg.llm.default).toBe("openai");
  });
});

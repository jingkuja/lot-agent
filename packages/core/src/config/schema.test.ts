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

  const baseCfg = {
    llm: { default: "openai", openai: { apiKey: "x", model: "m" }, anthropic: { apiKey: "", model: "m" } },
    agent: { maxIterations: 10, systemPrompt: "hi" },
    mcp: { servers: [] },
    server: { port: 3000, host: "0.0.0.0" },
  };

  it("parses optional model capabilities", () => {
    const cfg = AppConfigSchema.parse({
      ...baseCfg,
      models: [
        {
          id: "deepseek-v4-flash", type: "llm", provider: "openai", billingUnit: "token",
          inputPrice: 0.001, outputPrice: 0.002, unitPrice: 0, enabled: true,
          capabilities: { contextWindow: 128000, maxOutputTokens: 8192, vision: false, toolUse: true, reasoning: false },
        },
      ],
    });
    expect(cfg.models[0].capabilities?.contextWindow).toBe(128000);
    expect(cfg.models[0].capabilities?.toolUse).toBe(true);
  });

  it("accepts a model without capabilities (backward compatible)", () => {
    const cfg = AppConfigSchema.parse({
      ...baseCfg,
      models: [
        { id: "m1", type: "image", provider: "wanx", billingUnit: "image", inputPrice: 0, outputPrice: 0, unitPrice: 0.04, enabled: true },
      ],
    });
    expect(cfg.models[0].capabilities).toBeUndefined();
  });

  it("rejects a capabilities block with a wrong field type", () => {
    expect(() =>
      AppConfigSchema.parse({
        ...baseCfg,
        models: [
          {
            id: "m1", type: "llm", provider: "openai", billingUnit: "token",
            inputPrice: 0, outputPrice: 0, unitPrice: 0, enabled: true,
            capabilities: { contextWindow: "big" },
          },
        ],
      })
    ).toThrow();
  });
});

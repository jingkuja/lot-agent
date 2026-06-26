import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { loadLlmConfig } from "./config.js";

// repo root: this test sits at packages/server/src/config.test.ts
const ROOT = resolve(__dirname, "../../..");

describe("loadLlmConfig", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    delete process.env.LLM_DEFAULT;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("applies OPENAI_* and LLM_DEFAULT env overrides", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_MODEL = "gpt-test";
    process.env.LLM_DEFAULT = "openai";
    const llm = await loadLlmConfig(ROOT);
    expect(llm.default).toBe("openai");
    expect(llm.openai.apiKey).toBe("sk-test");
    expect(llm.openai.model).toBe("gpt-test");
  });

  it("falls back to config defaults when env is unset", async () => {
    const llm = await loadLlmConfig(ROOT);
    expect(llm.openai.apiKey).toBe(""); // default.json keeps keys empty
    expect(typeof llm.openai.model).toBe("string");
  });
});

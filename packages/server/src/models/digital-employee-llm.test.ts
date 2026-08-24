import { describe, expect, it, vi } from "vitest";
import {
  DIGITAL_EMPLOYEE_LLM_PRIORITY,
  pickDigitalEmployeeLlmModel,
  resolveDigitalEmployeeLlm,
} from "./digital-employee-llm.js";

describe("pickDigitalEmployeeLlmModel", () => {
  it.each([
    [["qwen3.7-max", "deepseek-v4-flash-selfhosted", "deepseek-v4-pro", "deepseek-v4-flash"], "deepseek-v4-flash"],
    [["qwen3.7-max", "deepseek-v4-flash-selfhosted", "deepseek-v4-pro"], "deepseek-v4-pro"],
    [["qwen3.7-max", "deepseek-v4-flash-selfhosted"], "deepseek-v4-flash-selfhosted"],
    [["qwen3.7-max"], "qwen3.7-max"],
  ])("uses the configured priority for %j", (models, expected) => {
    expect(pickDigitalEmployeeLlmModel(models)).toBe(expected);
    expect(DIGITAL_EMPLOYEE_LLM_PRIORITY).toContain(expected);
  });

  it("falls back to catalog order when no preferred model is available", () => {
    expect(pickDigitalEmployeeLlmModel(["model-b", "model-a"])).toBe("model-b");
    expect(pickDigitalEmployeeLlmModel([])).toBeNull();
  });
});

describe("resolveDigitalEmployeeLlm", () => {
  it("keeps the active key when it has an LLM", async () => {
    const list = vi.fn(async (key: string) => key === "active"
      ? ["model-active"]
      : ["deepseek-v4-flash"]);
    await expect(resolveDigitalEmployeeLlm("active", ["other"], list)).resolves.toMatchObject({
      apiKey: "active",
      modelId: "model-active",
    });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("walks the other keys when the active key has no LLM", async () => {
    const list = vi.fn(async (key: string) => {
      if (key === "active" || key === "empty") return [];
      return ["other", "qwen3.7-max", "deepseek-v4-pro"];
    });
    await expect(resolveDigitalEmployeeLlm(
      "active", ["active", "empty", "usable"], list
    )).resolves.toMatchObject({ apiKey: "usable", modelId: "deepseek-v4-pro" });
    expect(list.mock.calls.map(([key]) => key)).toEqual(["active", "empty", "usable"]);
  });

  it("finds a requested model on another key before using a fallback", async () => {
    const list = vi.fn(async (key: string) => key === "active"
      ? ["deepseek-v4-flash"]
      : ["requested-model"]);
    await expect(resolveDigitalEmployeeLlm(
      "active", ["other"], list, "requested-model"
    )).resolves.toMatchObject({ apiKey: "other", modelId: "requested-model" });
  });

  it("continues after catalog failure and returns null when no user key has an LLM", async () => {
    const list = vi.fn(async (key: string) => {
      if (key === "broken") throw new Error("tokenhub down");
      return [];
    });
    await expect(resolveDigitalEmployeeLlm("broken", ["empty"], list)).resolves.toBeNull();
  });
});

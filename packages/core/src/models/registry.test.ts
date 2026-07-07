import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryModelRegistry } from "./registry.js";
import type { ModelConfig } from "./types.js";

const llmModel: ModelConfig = {
  id: "deepseek-v4-flash",
  type: "llm",
  provider: "openai",
  billingUnit: "token",
  inputPrice: 0.001,
  outputPrice: 0.002,
  unitPrice: 0,
  enabled: true,
};

const imageModel: ModelConfig = {
  id: "wanx-standard",
  type: "image",
  provider: "wanx",
  billingUnit: "image",
  inputPrice: 0,
  outputPrice: 0,
  unitPrice: 0.04,
  enabled: true,
};

describe("InMemoryModelRegistry", () => {
  let registry: InMemoryModelRegistry;

  beforeEach(() => {
    registry = new InMemoryModelRegistry();
  });

  it("register + list returns all configs", () => {
    registry.register(llmModel, () => ({}));
    registry.register(imageModel, () => ({}));
    expect(registry.list()).toHaveLength(2);
  });

  it("list(type) filters by type", () => {
    registry.register(llmModel, () => ({}));
    registry.register(imageModel, () => ({}));
    expect(registry.list("image")).toHaveLength(1);
    expect(registry.list("image")[0].id).toBe("wanx-standard");
  });

  it("list('llm') returns only llm models", () => {
    registry.register(llmModel, () => ({}));
    registry.register(imageModel, () => ({}));
    expect(registry.list("llm")).toHaveLength(1);
    expect(registry.list("llm")[0].id).toBe("deepseek-v4-flash");
  });

  it("getConfig returns the pricing fields", () => {
    registry.register(llmModel, () => ({}));
    const cfg = registry.getConfig("deepseek-v4-flash");
    expect(cfg).toBeDefined();
    expect(cfg?.inputPrice).toBe(0.001);
    expect(cfg?.outputPrice).toBe(0.002);
    expect(cfg?.unitPrice).toBe(0);
    expect(cfg?.billingUnit).toBe("token");
    expect(cfg?.provider).toBe("openai");
  });

  it("getConfig returns undefined for unknown id", () => {
    expect(registry.getConfig("unknown")).toBeUndefined();
  });

  it("getProvider returns undefined for unknown id", () => {
    expect(registry.getProvider("unknown")).toBeUndefined();
  });

  it("getProvider lazily instantiates the provider (singleton)", () => {
    let callCount = 0;
    const fakeProvider = { chat: async function* () {} };
    registry.register(llmModel, () => {
      callCount++;
      return fakeProvider;
    });

    const p1 = registry.getProvider("deepseek-v4-flash");
    const p2 = registry.getProvider("deepseek-v4-flash");

    expect(callCount).toBe(1);
    expect(p1).toBe(p2); // same instance
    expect(p1).toBe(fakeProvider);
  });

  it("factory is NOT called until getProvider is invoked", () => {
    let callCount = 0;
    registry.register(llmModel, () => {
      callCount++;
      return {};
    });
    expect(callCount).toBe(0); // not called on register
  });

  it("list with no type arg returns all models", () => {
    registry.register(llmModel, () => ({}));
    registry.register(imageModel, () => ({}));
    expect(registry.list()).toHaveLength(2);
  });

  const disabledModel: ModelConfig = { ...imageModel, id: "wanx-legacy", enabled: false };

  it("list() hides disabled models by default", () => {
    registry.register(llmModel, () => ({}));
    registry.register(disabledModel, () => ({}));
    const ids = registry.list().map((m) => m.id);
    expect(ids).toEqual(["deepseek-v4-flash"]);
  });

  it("list(type) hides disabled models of that type", () => {
    registry.register(imageModel, () => ({}));
    registry.register(disabledModel, () => ({}));
    expect(registry.list("image")).toHaveLength(1);
    expect(registry.list("image")[0].id).toBe("wanx-standard");
  });

  it("list(type, { includeDisabled: true }) is the escape hatch", () => {
    registry.register(imageModel, () => ({}));
    registry.register(disabledModel, () => ({}));
    expect(registry.list("image", { includeDisabled: true })).toHaveLength(2);
    expect(registry.list(undefined, { includeDisabled: true })).toHaveLength(2);
  });

  it("getProvider returns undefined for a disabled model", () => {
    registry.register(disabledModel, () => ({ marker: true }));
    expect(registry.getProvider("wanx-legacy")).toBeUndefined();
  });

  it("getConfig still returns disabled models (pricing lookups need them)", () => {
    registry.register(disabledModel, () => ({}));
    expect(registry.getConfig("wanx-legacy")?.enabled).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { KnowledgeConfigSchema, createKnowledgeModule } from "./module.js";

describe("knowledge source switch", () => {
  it("defaults to remote for existing deployments and rejects invalid settings", () => {
    expect(KnowledgeConfigSchema.parse(undefined)).toEqual({ source: "remote" });
    expect(() => KnowledgeConfigSchema.parse({ source: "auto" })).toThrow();
    expect(() => KnowledgeConfigSchema.parse({ source: "local", fallback: "remote" })).toThrow();
  });
  it("refuses local activation until a local service is wired", () => {
    expect(() => createKnowledgeModule({ source: "local" })).toThrow("内置知识服务尚未装配");
  });
  it("selects the explicitly injected service and never catches its errors", async () => {
    const local = { listCollections: vi.fn().mockRejectedValue(new Error("db down")), retrieve: vi.fn() };
    const module = createKnowledgeModule({ source: "local" }, local);
    expect(module.source).toBe("local");
    if (module.source === "local") await expect(module.service.listCollections("u1")).rejects.toThrow("db down");
    expect(createKnowledgeModule(undefined, local)).toEqual({ source: "remote" });
  });
});

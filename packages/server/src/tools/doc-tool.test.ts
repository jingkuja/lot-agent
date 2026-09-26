import { describe, expect, it, vi } from "vitest";
import { createDocTool } from "./doc-tool.js";
const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("./doc-generator.js", () => ({ generateDocument: generate }));

describe("document cancellation", () => {
  function setup() {
    const controller = new AbortController();
    const storage = { put: vi.fn(async () => ({ url: "/document" })), delete: vi.fn(async () => {}) };
    const db = { createAsset: vi.fn(async () => {}) };
    const tool = createDocTool({ storage, db, fontPath: "" } as any);
    const ctx = { workingDirectory: "/tmp", signal: controller.signal };
    return { controller, storage, db, tool, ctx };
  }
  it("does not store a document whose rendering completed after cancellation", async () => {
    const { controller, storage, tool, ctx } = setup();
    generate.mockImplementationOnce(async () => { controller.abort(); return { buffer: Buffer.from("x"), format: "md" }; });
    await expect(tool.execute({ content: "x", format: "md" }, ctx)).rejects.toThrow();
    expect(storage.put).not.toHaveBeenCalled();
  });
  it("cleans up a newly stored file if cancellation precedes publishing its asset", async () => {
    const { controller, storage, db, tool, ctx } = setup();
    generate.mockResolvedValueOnce({ buffer: Buffer.from("x"), format: "md" });
    storage.put.mockImplementationOnce(async () => { controller.abort(); return { url: "/document" }; });
    await expect(tool.execute({ content: "x", format: "md" }, ctx)).rejects.toThrow();
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(db.createAsset).not.toHaveBeenCalled();
  });
});

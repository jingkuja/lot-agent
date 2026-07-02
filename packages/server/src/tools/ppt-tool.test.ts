import { describe, it, expect, vi } from "vitest";
import JSZip from "jszip";
import { createPptTool } from "./ppt-tool.js";
import type { ToolContext } from "@lot-agent/core";

const ctx = { workingDirectory: "/tmp", userId: "u1" } as ToolContext;

const validInput = {
  title: "年度总结",
  slides: [
    { layout: "cover", title: "年度总结" },
    { layout: "content", title: "回顾", bullets: ["A", "B"] },
  ],
};

function makeDeps() {
  const created: any[] = [];
  const put = vi.fn(async ({ key }: { key: string }) => ({
    url: `/static/documents/${key}`,
  }));
  return {
    created,
    storage: { put, get: vi.fn(), getUrl: (k: string) => k, delete: vi.fn() } as any,
    uploadStorage: { get: vi.fn(), put: vi.fn(), getUrl: (k: string) => k, delete: vi.fn() } as any,
    db: {
      createAsset: vi.fn(async (a: any) => { created.push(a); }),
      getAsset: vi.fn(async () => null),
    } as any,
  };
}

describe("generate_ppt tool", () => {
  it("renders, stores and returns a download link", async () => {
    const deps = makeDeps();
    const tool = createPptTool(deps);
    const r = await tool.execute(validInput, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("下载链接：/static/documents/");
    expect(deps.created.length).toBe(1);
    expect(deps.created[0]).toMatchObject({ userId: "u1", type: "document" });
  });

  it("rejects empty slides as validation error", async () => {
    const tool = createPptTool(makeDeps());
    const r = await tool.execute({ title: "x", slides: [] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.errorKind).toBe("validation");
  });

  it("rejects an unknown layout as validation error", async () => {
    const tool = createPptTool(makeDeps());
    const r = await tool.execute(
      { title: "x", slides: [{ layout: "fancy", title: "t" }] },
      ctx
    );
    expect(r.isError).toBe(true);
  });

  it("degrades to default theme when the template asset is missing", async () => {
    const deps = makeDeps(); // getAsset → null
    const tool = createPptTool(deps);
    const r = await tool.execute({ ...validInput, templateAssetId: "nope" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("模版解析失败，已使用默认样式");
  });

  it("uses the owner's template when present", async () => {
    const deps = makeDeps();
    const zip = new JSZip();
    zip.file("ppt/theme/theme1.xml", `<a:theme xmlns:a="x"><a:clrScheme><a:accent1><a:srgbClr val="1F4E79"/></a:accent1></a:clrScheme></a:theme>`);
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    deps.db.getAsset = vi.fn(async () => ({ id: "a1", user_id: "u1", storage_key: "a1.pptx" }));
    deps.uploadStorage.get = vi.fn(async () => bytes);
    const tool = createPptTool(deps);
    const r = await tool.execute({ ...validInput, templateAssetId: "a1" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).not.toContain("模版解析失败");
    expect(deps.uploadStorage.get).toHaveBeenCalledWith("a1.pptx");
  });
});

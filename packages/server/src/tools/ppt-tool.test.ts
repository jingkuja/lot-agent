import { describe, it, expect, vi } from "vitest";
import JSZip from "jszip";
import { createPptTool } from "./ppt-tool.js";
import { buildTemplatePptx } from "../ppt/template-renderer.fixture.js";
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

  it("notes the degradation when the template bytes are corrupt", async () => {
    const deps = makeDeps();
    deps.db.getAsset = vi.fn(async () => ({ id: "a1", user_id: "u1", storage_key: "a1.pptx" }));
    deps.uploadStorage.get = vi.fn(async () => Buffer.from("not a zip at all"));
    const tool = createPptTool(deps);
    const r = await tool.execute({ ...validInput, templateAssetId: "a1" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("模版解析失败，已使用默认样式");
  });

  it("clones a full template: output keeps its masters, layouts and media", async () => {
    const deps = makeDeps();
    let stored: Buffer | null = null;
    deps.storage.put = vi.fn(async ({ key, body }: { key: string; body: Buffer }) => {
      stored = body;
      return { url: `/static/documents/${key}` };
    });
    deps.db.getAsset = vi.fn(async () => ({ id: "a1", user_id: "u1", storage_key: "a1.pptx" }));
    deps.uploadStorage.get = vi.fn(async () => buildTemplatePptx());
    const tool = createPptTool(deps);
    const r = await tool.execute({ ...validInput, templateAssetId: "a1" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("已套用上传模版的版式");
    const zip = await JSZip.loadAsync(stored!);
    expect(zip.file("ppt/media/image1.png")).not.toBeNull();
    expect(zip.file("ppt/slideMasters/slideMaster1.xml")).not.toBeNull();
    const s1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(s1).toContain("<a:t>年度总结</a:t>");
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

// 极简内存桩：storage.put 返回固定 url，db.createAsset 记录一次
function makeV2Deps() {
  const puts: any[] = [];
  const storage = { put: async (o: any) => { puts.push(o); return { url: `/static/documents/${o.key}` }; }, get: async () => Buffer.from(""), delete: async () => {} } as any;
  const uploadStorage = { get: async () => { throw new Error("no template"); }, put: async () => ({ url: "" }), delete: async () => {} } as any;
  const db = { getAsset: async () => null, createAsset: async () => {} } as any;
  return { storage, uploadStorage, db, puts };
}

describe("generate_ppt", () => {
  it("rejects invalid stats slide via validateSlides", async () => {
    const { storage, uploadStorage, db } = makeV2Deps();
    const tool = createPptTool({ storage, uploadStorage, db });
    const r = await tool.execute({ title: "T", slides: [{ layout: "stats", title: "t", items: [{ label: "only" }] }] }, { userId: "u" } as any);
    expect(r.isError).toBe(true);
    expect(r.errorKind).toBe("validation");
  });

  it("renders a mixed deck with a theme preset", async () => {
    const { storage, uploadStorage, db, puts } = makeV2Deps();
    const tool = createPptTool({ storage, uploadStorage, db });
    const r = await tool.execute({
      title: "季度复盘", themePreset: "tech-dark",
      slides: [
        { layout: "cover", title: "季度复盘" },
        { layout: "stats", title: "数据", items: [{ value: "65%", label: "增长" }, { value: "3x", label: "效率" }] },
        { layout: "closing", title: "谢谢" },
      ],
    }, { userId: "u" } as any);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("/static/documents/");
    expect(puts).toHaveLength(1);
  });
});

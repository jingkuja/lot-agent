import { describe, it, expect } from "vitest";
import { parseDownloadArtifact } from "./download-artifact.js";

describe("parseDownloadArtifact", () => {
  const pptOutput =
    "已生成演示文稿「年度总结」（8 页）。\n" +
    "下载链接：/static/documents/294f49c2-787a-4f1b-bb0f-aab6b739ce99.pptx\n" +
    "asset_id: 294f49c2-787a-4f1b-bb0f-aab6b739ce99";

  it("extracts the trustworthy url + filename from a generate_ppt result", () => {
    expect(parseDownloadArtifact("generate_ppt", pptOutput)).toEqual({
      url: "/static/documents/294f49c2-787a-4f1b-bb0f-aab6b739ce99.pptx",
      filename: "294f49c2-787a-4f1b-bb0f-aab6b739ce99.pptx",
    });
  });

  it("works for generate_document too", () => {
    const doc =
      "已生成文档。\n下载链接：/static/documents/abc.docx\nasset_id: abc";
    expect(parseDownloadArtifact("generate_document", doc)).toEqual({
      url: "/static/documents/abc.docx",
      filename: "abc.docx",
    });
  });

  it("handles an absolute URL (PUBLIC_BASE_URL set)", () => {
    const doc =
      "已生成。\n下载链接：https://box.example.com/static/documents/x.pptx\nasset_id: x";
    expect(parseDownloadArtifact("generate_ppt", doc)?.filename).toBe("x.pptx");
    expect(parseDownloadArtifact("generate_ppt", doc)?.url).toBe(
      "https://box.example.com/static/documents/x.pptx"
    );
  });

  it("returns null for a non-download tool", () => {
    expect(parseDownloadArtifact("web_search", pptOutput)).toBeNull();
  });

  it("returns null for an errored result", () => {
    expect(parseDownloadArtifact("generate_ppt", pptOutput, true)).toBeNull();
  });

  it("returns null when the output carries no download link", () => {
    expect(
      parseDownloadArtifact("generate_ppt", "generate_ppt 校验失败：缺少 slides")
    ).toBeNull();
  });

  it("returns null for missing name/output", () => {
    expect(parseDownloadArtifact(undefined, pptOutput)).toBeNull();
    expect(parseDownloadArtifact("generate_ppt", undefined)).toBeNull();
  });
});

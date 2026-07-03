import { describe, it, expect, vi } from "vitest";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import {
  extractAttachment,
  attachmentKind,
  isSafeUploadKey,
  MAX_DOC_CHARS,
} from "./attachment-extractor.js";
import type { ObjectStorage } from "@lot-agent/core";
import type { AttachmentRef } from "./attachment-extractor.js";

function fakeStorage(bytes: Buffer): ObjectStorage {
  return {
    put: async () => ({ url: "" }),
    getUrl: () => "",
    delete: async () => {},
    get: async () => bytes,
  };
}
const base: AttachmentRef = { assetId: "a", filename: "f", mime: "", size: 0, url: "/static/uploads/x", kind: "doc" };

describe("attachmentKind", () => {
  it("classifies images vs docs", () => {
    expect(attachmentKind("image/png")).toBe("image");
    expect(attachmentKind("application/pdf")).toBe("doc");
    expect(attachmentKind("text/plain")).toBe("doc");
  });
});

describe("extractAttachment", () => {
  it("reads plain text and wraps with filename", async () => {
    const s = fakeStorage(Buffer.from("hello world"));
    const part = await extractAttachment({ ...base, filename: "note.txt", mime: "text/plain" }, s);
    expect(part).toEqual({ type: "text", text: "[附件: note.txt]\nhello world\n[/附件: note.txt]" });
  });

  it("makes a base64 data-url image part", async () => {
    const s = fakeStorage(Buffer.from([1, 2, 3]));
    const part = await extractAttachment({ ...base, filename: "p.png", mime: "image/png", kind: "image" }, s);
    expect(part).toEqual({ type: "image", image: { url: "data:image/png;base64,AQID", mediaType: "image/png" } });
  });

  it("truncates over-long documents", async () => {
    const s = fakeStorage(Buffer.from("x".repeat(MAX_DOC_CHARS + 100)));
    const part = await extractAttachment({ ...base, filename: "big.txt", mime: "text/plain" }, s);
    expect(part.type).toBe("text");
    expect((part.text as string).includes("[内容过长已截断]")).toBe(true);
  });

  it("parses an Excel workbook into CSV text per sheet", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["名称", "数量"], ["苹果", 3]]);
    XLSX.utils.book_append_sheet(wb, ws, "库存");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const s = fakeStorage(buf);
    const part = await extractAttachment(
      {
        ...base,
        filename: "data.xlsx",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      s
    );
    expect(part.type).toBe("text");
    expect(part.text as string).toContain("工作表: 库存");
    expect(part.text as string).toContain("名称,数量");
    expect(part.text as string).toContain("苹果,3");
  });

  it("degrades gracefully on unsupported type", async () => {
    const s = fakeStorage(Buffer.from("zzz"));
    const part = await extractAttachment({ ...base, filename: "a.bin", mime: "application/octet-stream" }, s);
    expect(part).toEqual({ type: "text", text: "[附件 a.bin 无法解析，已忽略内容]" });
  });

  it("strips an absolute PUBLIC_BASE_URL prefix from the upload url", async () => {
    // When PUBLIC_BASE_URL is set (compute box), upload urls are absolute, e.g.
    // http://<box-ip>:3000/static/uploads/<id>.<ext>. The key must still resolve.
    const s = fakeStorage(Buffer.from("hello"));
    const part = await extractAttachment(
      { ...base, filename: "n.txt", mime: "text/plain", url: "http://1.2.3.4:3000/static/uploads/abc.txt" },
      s
    );
    expect(part).toEqual({ type: "text", text: "[附件: n.txt]\nhello\n[/附件: n.txt]" });
  });

  it("rejects path-traversal urls without reading from storage", async () => {
    let read = false;
    const s: ObjectStorage = {
      put: async () => ({ url: "" }),
      getUrl: () => "",
      delete: async () => {},
      get: async () => {
        read = true;
        return Buffer.from("secret");
      },
    };
    const part = await extractAttachment(
      { ...base, filename: "x", mime: "text/plain", url: "/static/uploads/../../../etc/passwd" },
      s
    );
    expect(read).toBe(false);
    expect(part).toEqual({ type: "text", text: "[附件 x 无法访问，已忽略内容]" });
  });

  it("degrades gracefully when the stored file is missing", async () => {
    const s: ObjectStorage = {
      put: async () => ({ url: "" }),
      getUrl: () => "",
      delete: async () => {},
      get: async () => {
        throw new Error("ENOENT");
      },
    };
    const part = await extractAttachment({ ...base, filename: "gone.txt", mime: "text/plain" }, s);
    expect(part).toEqual({ type: "text", text: "[附件 gone.txt 无法读取，已忽略内容]" });
  });
});

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("extractAttachment: ppt slots", () => {
  it("turns a ppt_template attachment into a marker without reading storage", async () => {
    const storage = { get: vi.fn() } as any;
    const part = await extractAttachment(
      {
        assetId: "tpl-1", filename: "公司模版.pptx", mime: PPTX_MIME,
        size: 10, url: "/static/uploads/tpl-1.pptx", kind: "doc",
        slot: "ppt_template",
      },
      storage
    );
    expect(part).toEqual({
      type: "text",
      text: "[PPT模版已上传: 公司模版.pptx (templateAssetId: tpl-1)]",
    });
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("extracts per-slide text from a pptx content file", async () => {
    const zip = new JSZip();
    zip.file(
      "ppt/slides/slide1.xml",
      `<p:sld xmlns:a="x"><a:t>标题一</a:t><a:t>要点A</a:t></p:sld>`
    );
    zip.file(
      "ppt/slides/slide2.xml",
      `<p:sld xmlns:a="x"><a:t>标题二</a:t></p:sld>`
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const storage = { get: vi.fn(async () => bytes) } as any;
    const part = await extractAttachment(
      {
        assetId: "c1", filename: "旧稿.pptx", mime: PPTX_MIME,
        size: bytes.length, url: "/static/uploads/c1.pptx", kind: "doc",
      },
      storage
    );
    expect(part.type).toBe("text");
    expect(part.text).toContain("标题一");
    expect(part.text).toContain("要点A");
    expect(part.text).toContain("标题二");
  });
});

describe("extractAttachment: contract slots", () => {
  const contractBase = {
    assetId: "c-old", size: 10, kind: "doc" as const,
  };

  it("wraps contract_old text with 旧版合同 markers", async () => {
    const storage = { get: vi.fn(async () => Buffer.from("第一条 甲方为A公司")) } as any;
    const part = await extractAttachment(
      {
        ...contractBase, filename: "old.txt", mime: "text/plain",
        url: "/static/uploads/c-old.txt", slot: "contract_old",
      },
      storage
    );
    expect(part).toEqual({
      type: "text",
      text: "[旧版合同: old.txt]\n第一条 甲方为A公司\n[/旧版合同: old.txt]",
    });
  });

  it("wraps contract_new text with 新版合同 markers", async () => {
    const storage = { get: vi.fn(async () => Buffer.from("第一条 甲方为B公司")) } as any;
    const part = await extractAttachment(
      {
        ...contractBase, assetId: "c-new", filename: "new.txt", mime: "text/plain",
        url: "/static/uploads/c-new.txt", slot: "contract_new",
      },
      storage
    );
    expect(part).toEqual({
      type: "text",
      text: "[新版合同: new.txt]\n第一条 甲方为B公司\n[/新版合同: new.txt]",
    });
  });

  it("keeps the generic degradation copy when a contract file is unreadable", async () => {
    const storage = {
      get: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    } as any;
    const part = await extractAttachment(
      {
        ...contractBase, filename: "gone.pdf", mime: "application/pdf",
        url: "/static/uploads/c-old.pdf", slot: "contract_old",
      },
      storage
    );
    expect(part).toEqual({ type: "text", text: "[附件 gone.pdf 无法读取，已忽略内容]" });
  });
});

describe("isSafeUploadKey", () => {
  it("accepts flat uuid.ext keys and rejects traversal/separators", () => {
    expect(isSafeUploadKey("a1b2.png")).toBe(true);
    expect(isSafeUploadKey("../etc/passwd")).toBe(false);
    expect(isSafeUploadKey("sub/dir.png")).toBe(false);
    expect(isSafeUploadKey("a\\b.png")).toBe(false);
    expect(isSafeUploadKey("")).toBe(false);
  });
});

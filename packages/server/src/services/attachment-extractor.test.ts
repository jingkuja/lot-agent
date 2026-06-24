import { describe, it, expect } from "vitest";
import { extractAttachment, attachmentKind, MAX_DOC_CHARS } from "./attachment-extractor.js";
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

  it("degrades gracefully on unsupported type", async () => {
    const s = fakeStorage(Buffer.from("zzz"));
    const part = await extractAttachment({ ...base, filename: "a.bin", mime: "application/octet-stream" }, s);
    expect(part).toEqual({ type: "text", text: "[附件 a.bin 无法解析，已忽略内容]" });
  });
});

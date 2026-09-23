import { describe, expect, it } from "vitest";
import { KnowledgeItemInputSchema, KnowledgeUploadMetadataSchema, KnowledgeItemUpdateSchema } from "./manage.js";

describe("knowledge management input boundary", () => {
  it("rejects caller-controlled ownership, revision and private object keys", () => {
    for (const field of ["ownerId", "owner_id", "activeRevisionId", "object", "storageKey"]) {
      expect(() => KnowledgeItemInputSchema.parse({ title: "笔记", sourceType: "note", content: "正文", [field]: "forged" })).toThrow();
    }
  });
  it("requires note content and limits bookmarks to inert HTTP(S) references", () => {
    expect(() => KnowledgeItemInputSchema.parse({ title: "空笔记", sourceType: "note", content: " " })).toThrow();
    expect(() => KnowledgeItemInputSchema.parse({ title: "书签", sourceType: "bookmark" })).toThrow();
    for (const sourceUrl of ["javascript:alert(1)", "file:///etc/passwd", "ftp://server/file"]) {
      expect(() => KnowledgeItemInputSchema.parse({ title: "书签", sourceType: "bookmark", sourceUrl })).toThrow();
    }
    expect(KnowledgeItemInputSchema.parse({ title: "书签", sourceType: "bookmark", sourceUrl: "https://example.com" }).sourceUrl).toBe("https://example.com");
  });
  it("rejects duplicate collections, invalid filenames and writes without an expected version", () => {
    const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    expect(() => KnowledgeUploadMetadataSchema.parse({ title: "file", collectionIds: [id, id] })).toThrow();
    for (const title of ["../secret", "a\\b", "a\nb", " "]) expect(() => KnowledgeUploadMetadataSchema.parse({ title })).toThrow();
    expect(() => KnowledgeItemUpdateSchema.parse({ title: "no version" })).toThrow();
  });
});

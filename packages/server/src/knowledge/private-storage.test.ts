import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { LocalKnowledgeStorage } from "./private-storage.js";
const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "rag-storage-")); dirs.push(dir);
  return { dir, storage: new LocalKnowledgeStorage(dir, 100) };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
describe("private knowledge streaming storage", () => {
  it("deduplicates per owner and never returns a public URL", async () => {
    const { storage } = await fixture(); const owner = randomUUID();
    const [a, b] = await Promise.all([1, 2].map(() => storage.put(owner, Readable.from([Buffer.from("中文内容")]), "text/plain")));
    expect(a).toEqual(b); expect(a).not.toHaveProperty("url"); expect(a.size).toBe(12);
    const other = await storage.put(randomUUID(), Readable.from([Buffer.from("中文内容")]), "text/plain");
    expect(other.key).not.toBe(a.key);
    expect(await storage.size(a.key)).toBe(12);
  });
  it("removes incomplete uploads on overflow or stream failure", async () => {
    const { dir, storage } = await fixture();
    await expect(storage.put(randomUUID(), Readable.from([Buffer.alloc(101)]), "text/plain")).rejects.toMatchObject({ status: 413 });
    const broken = Readable.from((async function* () { yield Buffer.from("partial"); throw new Error("aborted"); })());
    await expect(storage.put(randomUUID(), broken, "text/plain")).rejects.toThrow("aborted");
    expect(await readdir(join(dir, ".staging"))).toEqual([]);
  });
  it("rejects traversal, active MIME, empty files and mismatched signatures", async () => {
    const { storage } = await fixture();
    await expect(storage.put("../escape", Readable.from(["hi"]), "text/plain")).rejects.toThrow();
    await expect(storage.size("../escape")).rejects.toThrow();
    for (const [mime, bytes] of [["text/html", "<script/>"], ["image/png", "not png"], ["text/plain", ""]]) {
      await expect(storage.put(randomUUID(), Readable.from([Buffer.from(bytes)]), mime)).rejects.toThrow();
    }
  });
});

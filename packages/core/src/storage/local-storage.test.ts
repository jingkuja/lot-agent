import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LocalStorage } from "./local-storage.js";

describe("LocalStorage", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("put writes the file and returns the correct url", async () => {
    dir = await mkdtemp(join(tmpdir(), "ls-test-"));
    const storage = new LocalStorage(dir);
    const body = Buffer.from("hello");
    const result = await storage.put({ key: "a/b.png", body, contentType: "image/png" });
    expect(result).toEqual({ url: "/static/assets/a/b.png" });
    const content = await readFile(join(dir, "a/b.png"));
    expect(content.toString()).toBe("hello");
  });

  it("getUrl returns prefixed url", async () => {
    dir = await mkdtemp(join(tmpdir(), "ls-test-"));
    const storage = new LocalStorage(dir);
    expect(storage.getUrl("x.png")).toBe("/static/assets/x.png");
  });

  it("delete removes the file", async () => {
    dir = await mkdtemp(join(tmpdir(), "ls-test-"));
    const storage = new LocalStorage(dir);
    await storage.put({ key: "a/b.png", body: Buffer.from("hello"), contentType: "image/png" });
    await storage.delete("a/b.png");
    await expect(readFile(join(dir, "a/b.png"))).rejects.toThrow();
  });

  it("delete on non-existent key does not throw", async () => {
    dir = await mkdtemp(join(tmpdir(), "ls-test-"));
    const storage = new LocalStorage(dir);
    await expect(storage.delete("nonexistent.png")).resolves.toBeUndefined();
  });

  it("get() reads back what put() wrote", async () => {
    dir = await mkdtemp(join(tmpdir(), "ls-test-"));
    const storage = new LocalStorage(dir);
    await storage.put({ key: "a.txt", body: Buffer.from("hello"), contentType: "text/plain" });
    const buf = await storage.get("a.txt");
    expect(buf.toString("utf8")).toBe("hello");
  });

  it("putStream streams a readable to disk without buffering the whole body", async () => {
    dir = await mkdtemp(join(tmpdir(), "ls-test-"));
    const storage = new LocalStorage(dir);
    const source = Readable.from([Buffer.from("chunk-1;"), Buffer.from("chunk-2")]);

    const res = await storage.putStream("videos/v.mp4", source, "video/mp4");

    expect(res).toEqual({ url: "/static/assets/videos/v.mp4" });
    const content = await readFile(join(dir, "videos/v.mp4"));
    expect(content.toString()).toBe("chunk-1;chunk-2");
  });

  it("exists reflects presence of an object", async () => {
    dir = await mkdtemp(join(tmpdir(), "ls-test-"));
    const storage = new LocalStorage(dir);
    expect(await storage.exists("a.txt")).toBe(false);
    await storage.put({ key: "a.txt", body: Buffer.from("hi"), contentType: "text/plain" });
    expect(await storage.exists("a.txt")).toBe(true);
  });

  it("getUrl ignores expiry options for the local driver", async () => {
    dir = await mkdtemp(join(tmpdir(), "ls-test-"));
    const storage = new LocalStorage(dir);
    expect(storage.getUrl("x.png", { expiresInSec: 60 })).toBe("/static/assets/x.png");
  });
});

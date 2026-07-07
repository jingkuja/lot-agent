import { mkdir, writeFile, unlink, readFile, access } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, resolve } from "node:path";
import type { ObjectStorage, PutObjectInput } from "./types.js";

export class LocalStorage implements ObjectStorage {
  constructor(
    private readonly rootDir: string,
    private readonly urlPrefix = "/static/assets"
  ) {}

  async put({ key, body }: PutObjectInput): Promise<{ url: string }> {
    const filePath = resolve(this.rootDir, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    return { url: this.getUrl(key) };
  }

  async putStream(
    key: string,
    body: NodeJS.ReadableStream,
    _contentType: string,
    _sizeHint?: number
  ): Promise<{ url: string }> {
    const filePath = resolve(this.rootDir, key);
    await mkdir(dirname(filePath), { recursive: true });
    // Backpressure-aware copy — never holds the whole body in memory.
    await pipeline(body, createWriteStream(filePath));
    return { url: this.getUrl(key) };
  }

  getUrl(key: string, _opts?: { expiresInSec?: number }): string {
    // Local files are served statically; there is nothing to presign.
    return `${this.urlPrefix}/${key}`;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(resolve(this.rootDir, key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(resolve(this.rootDir, key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(resolve(this.rootDir, key));
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  }
}

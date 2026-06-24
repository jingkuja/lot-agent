import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
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

  getUrl(key: string): string {
    return `${this.urlPrefix}/${key}`;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(resolve(this.rootDir, key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(resolve(this.rootDir, key));
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  }
}

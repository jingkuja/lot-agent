import { describe, it, expect } from "vitest";
import { genCacheKey } from "./gen-cache.js";

describe("genCacheKey", () => {
  it("produces the same key regardless of object key insertion order", () => {
    const key1 = genCacheKey("image.generate", { prompt: "hello", size: "512x512", style: "vivid" });
    const key2 = genCacheKey("image.generate", { style: "vivid", prompt: "hello", size: "512x512" });
    expect(key1).toBe(key2);
  });

  it("produces the same key for identical nested objects with different key order", () => {
    const key1 = genCacheKey("video.generate", { prompt: "sunset", config: { fps: 30, durationSec: 5 } });
    const key2 = genCacheKey("video.generate", { config: { durationSec: 5, fps: 30 }, prompt: "sunset" });
    expect(key1).toBe(key2);
  });

  it("produces different keys for different inputs", () => {
    const key1 = genCacheKey("image.generate", { prompt: "cat" });
    const key2 = genCacheKey("image.generate", { prompt: "dog" });
    expect(key1).not.toBe(key2);
  });

  it("produces different keys for different types with same input", () => {
    const key1 = genCacheKey("image.generate", { prompt: "cat" });
    const key2 = genCacheKey("video.generate", { prompt: "cat" });
    expect(key1).not.toBe(key2);
  });

  it("key starts with gen:<type>: prefix", () => {
    const key = genCacheKey("image.generate", { prompt: "test" });
    expect(key).toMatch(/^gen:image\.generate:[a-f0-9]{64}$/);
  });

  it("handles array inputs stably", () => {
    const key1 = genCacheKey("batch", [1, 2, 3]);
    const key2 = genCacheKey("batch", [1, 2, 3]);
    expect(key1).toBe(key2);
  });
});

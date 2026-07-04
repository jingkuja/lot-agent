import { describe, it, expect } from "vitest";
import { withLLMRetry } from "./retry.js";
import type { ChatChunk } from "../types/index.js";

async function drain(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe("withLLMRetry", () => {
  it("retries a retryable failure and succeeds on a later attempt", async () => {
    let calls = 0;
    async function* stream() {
      calls++;
      if (calls < 3) throw new Error("429 rate limit");
      yield { type: "text", content: "ok" } as ChatChunk;
    }
    const out = await drain(withLLMRetry(stream, { baseDelayMs: 1 }));
    expect(calls).toBe(3);
    expect(out).toEqual([{ type: "text", content: "ok" }]);
  });

  it("does not retry once a chunk has already been yielded", async () => {
    let calls = 0;
    async function* stream() {
      calls++;
      yield { type: "text", content: "partial" } as ChatChunk;
      throw new Error("500 internal error");
    }
    await expect(drain(withLLMRetry(stream, { baseDelayMs: 1 }))).rejects.toThrow(
      "500 internal error"
    );
    expect(calls).toBe(1);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    let calls = 0;
    async function* stream() {
      calls++;
      throw new Error("429 rate limit");
    }
    await expect(
      drain(withLLMRetry(stream, { maxRetries: 1, baseDelayMs: 1 }))
    ).rejects.toThrow("429 rate limit");
    expect(calls).toBe(2); // initial attempt + 1 retry
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    async function* stream() {
      calls++;
      throw new Error("400 bad request");
    }
    await expect(drain(withLLMRetry(stream, { baseDelayMs: 1 }))).rejects.toThrow(
      "400 bad request"
    );
    expect(calls).toBe(1);
  });

  it("honors a custom isRetryable predicate", async () => {
    let calls = 0;
    async function* stream() {
      calls++;
      if (calls < 2) throw new Error("custom-retryable");
      yield { type: "text", content: "ok" } as ChatChunk;
    }
    const out = await drain(
      withLLMRetry(stream, {
        baseDelayMs: 1,
        isRetryable: (err) => err instanceof Error && err.message === "custom-retryable",
      })
    );
    expect(out).toEqual([{ type: "text", content: "ok" }]);
  });
});

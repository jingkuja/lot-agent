import { describe, it, expect } from "vitest";
import { withLLMRetry, isMalformedToolCallError } from "./retry.js";
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

  it("aborts immediately during backoff instead of waiting out the full delay", async () => {
    let calls = 0;
    async function* stream() {
      calls++;
      throw new Error("429 rate limit");
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const start = Date.now();
    await expect(
      drain(
        withLLMRetry(stream, { baseDelayMs: 5000, signal: controller.signal })
      )
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(calls).toBe(1); // aborted during backoff, never re-invoked createStream
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

describe("isMalformedToolCallError", () => {
  it("matches the vendor's incomplete/malformed tool-call rejection", () => {
    // The exact message a gateway returns when the model streams truncated or
    // garbled tool-call JSON — a sampling artifact that a fresh call usually fixes.
    const err = new Error(
      "The model returned incomplete tool_call arguments. Function 'propose_outline' has malformed arguments. Please retry the request."
    );
    expect(isMalformedToolCallError(err)).toBe(true);
  });

  it("matches phrasing variants (tool call / invalid arguments)", () => {
    expect(
      isMalformedToolCallError(new Error("invalid tool call arguments produced"))
    ).toBe(true);
    expect(isMalformedToolCallError("malformed tool_call arguments")).toBe(true);
  });

  it("matches the gateway's Python JSON-decoder rejection of tool-call args", () => {
    // DeepSeek/tokenhub (Python backend) forwards json.loads' error verbatim when
    // the model emits invalid JSON for a tool call — no "tool_call"/"malformed"
    // keyword, just the decoder's position signature. Still a sampling artifact.
    expect(
      isMalformedToolCallError(new Error("400 Expecting ',' delimiter: line 1 column 237 (char 236)"))
    ).toBe(true);
    expect(
      isMalformedToolCallError(
        new Error("Expecting property name enclosed in double quotes: line 1 column 2 (char 1)")
      )
    ).toBe(true);
    expect(
      isMalformedToolCallError(new Error("Unterminated string starting at: line 1 column 40 (char 39)"))
    ).toBe(true);
  });

  it("does not match unrelated 400 bad requests", () => {
    expect(isMalformedToolCallError(new Error("400 bad request: invalid model"))).toBe(
      false
    );
    expect(isMalformedToolCallError(new Error("context length exceeded"))).toBe(false);
    // A JSON-decoder keyword WITHOUT the position signature is not enough to
    // assume a tool-call artifact (avoids retrying genuine client errors).
    expect(isMalformedToolCallError(new Error("400 bad request: unexpected delimiter in path"))).toBe(false);
  });

  it("is retried by withLLMRetry as a custom predicate", async () => {
    let calls = 0;
    async function* stream() {
      calls++;
      if (calls < 2) {
        throw new Error(
          "Function 'propose_outline' has malformed arguments. Please retry the request."
        );
      }
      yield { type: "text", content: "ok" } as ChatChunk;
    }
    const out = await drain(
      withLLMRetry(stream, { baseDelayMs: 1, isRetryable: isMalformedToolCallError })
    );
    expect(calls).toBe(2);
    expect(out).toEqual([{ type: "text", content: "ok" }]);
  });
});

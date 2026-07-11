import { describe, it, expect, vi } from "vitest";
import type { ChatChunk, Message } from "@lot-agent/core";
import { meterLLM } from "./metered-llm.js";

function providerOf(chunks: ChatChunk[]) {
  return {
    async *chat(_m: Message[]): AsyncIterable<ChatChunk> {
      for (const c of chunks) yield c;
    },
  };
}

async function drain(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("meterLLM", () => {
  it("forwards chunks unchanged and reports the done chunk's usage", async () => {
    const chunks: ChatChunk[] = [
      { type: "text", content: "note" },
      { type: "done", usage: { promptTokens: 11, completionTokens: 4 } },
    ];
    const onUsage = vi.fn();
    const seen = await drain(meterLLM(providerOf(chunks), onUsage).chat([]));

    expect(seen).toEqual(chunks);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 11, completionTokens: 4 });
  });

  it("does not report when the stream carries no usage", async () => {
    const onUsage = vi.fn();
    await drain(meterLLM(providerOf([{ type: "text", content: "x" }]), onUsage).chat([]));
    expect(onUsage).not.toHaveBeenCalled();
  });
});

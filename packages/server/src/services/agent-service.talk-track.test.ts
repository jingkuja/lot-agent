import { describe, expect, it } from "vitest";
import type { ChatOptions, LLMProvider, Message } from "@lot-agent/core";
import { completeTalkTrackReply } from "./agent-service.js";

describe("completeTalkTrackReply", () => {
  it("returns the first visible reply without retrying", async () => {
    let calls = 0;
    const llm: LLMProvider = {
      async *chat() {
        calls += 1;
        yield { type: "text", content: "您好，想和您确认一下合同反馈。" } as const;
        yield { type: "done", finishReason: "stop" } as const;
      },
    };

    await expect(completeTalkTrackReply(llm, [
      { role: "user", content: "生成跟进话术" },
    ])).resolves.toBe("您好，想和您确认一下合同反馈。");
    expect(calls).toBe(1);
  });

  it("retries an empty reasoning-only result without exposing the thinking", async () => {
    const requests: Array<{ messages: Message[]; opts?: ChatOptions }> = [];
    const llm: LLMProvider = {
      async *chat(messages, _tools, opts) {
        requests.push({ messages, opts });
        if (requests.length === 1) {
          yield { type: "thinking", content: "private reasoning" } as const;
          yield { type: "done", finishReason: "length" } as const;
          return;
        }
        yield { type: "text", content: "李姐，机房运维方案您看得怎么样？" } as const;
        yield { type: "done", finishReason: "stop" } as const;
      },
    };

    const reply = await completeTalkTrackReply(llm, [
      { role: "user", content: "生成产品推介话术" },
    ]);

    expect(reply).toBe("李姐，机房运维方案您看得怎么样？");
    expect(reply).not.toContain("private reasoning");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.content).toContain("正文不能为空");
    expect(requests[0]?.opts?.params?.maxTokens).toBe(1_600);
    expect(requests[1]?.opts?.params?.maxTokens).toBe(3_200);
  });
});

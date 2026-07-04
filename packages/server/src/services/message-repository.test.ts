import { describe, it, expect } from "vitest";
import { MessageRepository } from "./message-repository.js";

// 最小 db stub：记录 addMessage / addToolCall 调用并能回放 getMessages
function memDb() {
  const rows: any[] = [];
  const toolCalls: any[] = [];
  return {
    rows,
    toolCalls,
    addMessage: async (id: string, cid: string, role: string, content: string, opts: any = {}) => {
      rows.push({
        id, conversation_id: cid, role, content,
        tool_call_id: opts.toolCallId ?? null,
        metadata: opts.metadata ?? {},
      });
    },
    addToolCall: async (messageId: string, toolCallId: string, toolName: string, toolInput: unknown) => {
      toolCalls.push({ message_id: messageId, tool_call_id: toolCallId, tool_name: toolName, tool_input: toolInput });
    },
    getMessages: async () => rows,
    getToolCallsForConversation: async () => {
      const map = new Map<string, any[]>();
      for (const tc of toolCalls) {
        const list = map.get(tc.message_id) ?? [];
        list.push(tc);
        map.set(tc.message_id, list);
      }
      return map;
    },
  } as any;
}

describe("saveUserMessage", () => {
  it("stores attachments in metadata", async () => {
    const db = memDb();
    const repo = new MessageRepository(db);
    const att = [{ assetId: "a1", filename: "n.txt", mime: "text/plain", size: 2, url: "/static/uploads/a1.txt", kind: "doc" as const }];
    const id = await repo.saveUserMessage("c1", "hi", att);
    const row = db.rows.find((r: any) => r.id === id);
    expect(row.metadata.attachments).toEqual(att);
  });

  it("writes empty metadata when no attachments", async () => {
    const db = memDb();
    const repo = new MessageRepository(db);
    const id = await repo.saveUserMessage("c1", "hi");
    const row = db.rows.find((r: any) => r.id === id);
    expect(row.metadata).toEqual({});
  });
});

describe("loadHistory materialize", () => {
  it("rebuilds user content with materialized attachment parts", async () => {
    const db = memDb();
    const repo = new MessageRepository(db);
    const att = [{ assetId: "a1", filename: "n.txt", mime: "text/plain", size: 2, url: "/static/uploads/a1.txt", kind: "doc" as const }];
    // an older user message with attachments, plus an assistant reply
    await repo.saveUserMessage("c1", "see file", att);
    db.rows.push({ id: "asst", conversation_id: "c1", role: "assistant", content: "ok", tool_call_id: null, tool_calls: null, metadata: {} });

    const history = await repo.loadHistory("c1", "nonexistent", async () => [
      { type: "text", text: "[附件: n.txt]\nhello\n[/附件: n.txt]" },
    ]);

    const userMsg = history.find((m) => m.role === "user")!;
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content).toEqual([
      { type: "text", text: "see file" },
      { type: "text", text: "[附件: n.txt]\nhello\n[/附件: n.txt]" },
    ]);
  });
});

describe("loadHistory tool-call reconstruction", () => {
  it("re-attaches assistant toolCalls and keeps the matching tool result across requests", async () => {
    const db = memDb();
    const repo = new MessageRepository(db);
    // Simulate a prior endsTurn tool round: assistant issues propose_outline,
    // its result is stored, then the user confirms — exactly the PPT flow.
    const asstId = await repo.saveAssistantWithToolCalls(
      "c1",
      "",
      [{ id: "call_1", name: "propose_outline", arguments: { title: "T", slides: [{ layout: "cover", title: "T" }] } }]
    );
    await repo.saveToolResult("c1", "call_1", "[大纲已展示给用户，等待确认或修改意见]");
    await repo.saveUserMessage("c1", "确认，按此大纲生成");

    const history = await repo.loadHistory("c1", "nonexistent");

    const asst = history.find((m) => m.role === "assistant")!;
    expect(asst.toolCalls).toEqual([
      { id: "call_1", name: "propose_outline", arguments: { title: "T", slides: [{ layout: "cover", title: "T" }] } },
    ]);
    // The tool result must survive (not be dropped as an orphan) and reference the call.
    const toolMsg = history.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.toolCallId).toBe("call_1");
    expect(asstId).toBeTruthy();
  });

  it("omits an assistant tool_call that has no stored result (keeps calls/results paired)", async () => {
    const db = memDb();
    const repo = new MessageRepository(db);
    // Assistant issued a tool call but the run aborted before a result was saved.
    await repo.saveAssistantWithToolCalls("c1", "", [
      { id: "call_x", name: "generate_ppt", arguments: { title: "T" } },
    ]);
    await repo.saveUserMessage("c1", "next");

    const history = await repo.loadHistory("c1", "nonexistent");
    const asst = history.find((m) => m.role === "assistant")!;
    // No paired result → must not surface a dangling tool_call to the API.
    expect(asst.toolCalls).toBeUndefined();
    expect(history.some((m) => m.role === "tool")).toBe(false);
  });

  it("still drops a genuinely orphan tool message (no matching tool call)", async () => {
    const db = memDb();
    const repo = new MessageRepository(db);
    await repo.saveToolResult("c1", "dangling", "orphaned result");
    const history = await repo.loadHistory("c1", "nonexistent");
    expect(history.find((m) => m.role === "tool")).toBeUndefined();
  });
});

describe("saveAssistantWithToolCalls thinking metadata", () => {
  it("stores thinking text in metadata when provided", async () => {
    const db = memDb();
    const repo = new MessageRepository(db);
    const id = await repo.saveAssistantWithToolCalls("c1", "answer", [], "reasoning trace");
    const row = db.rows.find((r: any) => r.id === id);
    expect(row.metadata.thinking).toBe("reasoning trace");
  });

  it("writes empty metadata when no thinking is given", async () => {
    const db = memDb();
    const repo = new MessageRepository(db);
    const id = await repo.saveAssistantWithToolCalls("c1", "answer", []);
    const row = db.rows.find((r: any) => r.id === id);
    expect(row.metadata).toEqual({});
  });
});

describe("saveFinalAssistant thinking metadata", () => {
  it("stores thinking text in metadata when provided", async () => {
    const db = memDb();
    const repo = new MessageRepository(db);
    await repo.saveFinalAssistant("c1", "final answer", [], "final reasoning");
    const row = db.rows.find((r: any) => r.content === "final answer");
    expect(row.metadata.thinking).toBe("final reasoning");
  });
});

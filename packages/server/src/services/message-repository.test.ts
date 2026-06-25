import { describe, it, expect } from "vitest";
import { MessageRepository } from "./message-repository.js";

// 最小 db stub：记录 addMessage 调用并能回放 getMessages
function memDb() {
  const rows: any[] = [];
  return {
    rows,
    addMessage: async (id: string, cid: string, role: string, content: string, opts: any = {}) => {
      rows.push({
        id, conversation_id: cid, role, content,
        tool_call_id: opts.toolCallId ?? null, tool_calls: null,
        metadata: opts.metadata ?? {},
      });
    },
    getMessages: async () => rows,
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

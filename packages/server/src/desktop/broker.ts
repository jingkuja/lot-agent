import { randomBytes, randomUUID } from "node:crypto";
import type { Tool, ToolResult } from "@lot-agent/core";
import { localToolDefinitions, validLocalInput, type LocalToolRequest } from "@lot-agent/core/desktop";

interface Pending {
  request: LocalToolRequest;
  delivered: boolean;
  finish: (result: ToolResult) => void;
}
interface Session {
  userId: string;
  conversationId: string;
  expires: number;
  claimed: boolean;
  pending?: Pending;
}
const failure = (): ToolResult => ({ content: "Desktop disconnected or operation cancelled. Verify local writes before repeating.", isError: true, errorKind: "unknown_outcome" });

/** Capabilities stay in Electron main, bound to an owner and a single chat turn.
 * No server filesystem/shell implementation is registered here.
 * In-memory broker requires sticky routing when using multiple API processes. */
export class DesktopToolBroker {
  private sessions = new Map<string, Session>();
  private sweep() {
    for (const [key, session] of this.sessions) if (session.expires < Date.now()) this.close(key);
  }
  create(userId: string, conversationId: string): string {
    this.sweep();
    if (this.sessions.size >= 1000 || [...this.sessions.values()].filter(s => s.userId === userId).length >= 4) throw new Error("Too many desktop sessions");
    const key = randomBytes(32).toString("hex");
    this.sessions.set(key, { userId, conversationId, claimed: false, expires: Date.now() + 30_000 });
    return key;
  }
  private get(key: string, userId: string, conversationId: string) {
    this.sweep();
    const session = this.sessions.get(key);
    return session?.userId === userId && session.conversationId === conversationId ? session : undefined;
  }
  poll(key: string, userId: string, conversationId: string) {
    const session = this.get(key, userId, conversationId);
    if (!session) return undefined;
    // Unclaimed sessions cannot be kept alive indefinitely.
    if (session.claimed) session.expires = Date.now() + 30_000;
    const pending = session.pending;
    const request = pending && !pending.delivered ? pending.request : null;
    if (pending) pending.delivered = true; // Never redeliver a potentially executed write.
    return { request, activeRequestId: pending?.request.id ?? null };
  }
  complete(key: string, userId: string, conversationId: string, id: string, result: ToolResult): boolean {
    const session = this.get(key, userId, conversationId);
    if (!session?.pending?.delivered || session.pending.request.id !== id) return false;
    session.pending.finish(result);
    return true;
  }
  revoke(key: string, userId: string, conversationId: string): boolean {
    if (!this.get(key, userId, conversationId)) return false;
    this.close(key);
    return true;
  }
  close(key: string) {
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    session?.pending?.finish(failure());
  }
  claim(key: string, userId: string, conversationId: string): Tool[] | undefined {
    const session = this.get(key, userId, conversationId);
    if (!session || session.claimed) return undefined;
    session.claimed = true;
    return localToolDefinitions.map(definition => ({
      ...definition,
      execConfig: { timeoutMs: 300_000 },
      retrySafe: false,
      execute: async (input, context) => {
        if (context.userId !== userId || context.conversationId !== conversationId || !this.get(key, userId, conversationId)) return { content: "Desktop capability unavailable", isError: true, errorKind: "permission" };
        if (!validLocalInput(definition.name, input)) return { content: "Invalid local tool input", isError: true, errorKind: "validation" };
        if (context.signal?.aborted) return failure();
        if (session.pending) return { content: "Another local operation is pending", isError: true, errorKind: "permission" };
        return new Promise<ToolResult>(resolve => {
          const finish = (result: ToolResult) => {
            clearInterval(watchdog);
            context.signal?.removeEventListener("abort", abort);
            session.pending = undefined;
            resolve(result);
          };
          const abort = () => finish(failure());
          const watchdog = setInterval(() => {
            if (session.expires < Date.now()) this.close(key);
          }, 1000);
          watchdog.unref();
          session.pending = { request: { id: randomUUID(), name: definition.name, input }, delivered: false, finish };
          context.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    }));
  }
}

import { randomUUID } from "node:crypto";
import type { LocalApproval, LocalPermissionMode } from "../../../web/src/types/desktop.js";

/** Main-process authority. Renderer snapshots never contain credentials or grants. */
export class ToolApprovals {
  private modes = new Map<string, LocalPermissionMode>();
  private granted = new Set<string>();
  private draftMode: LocalPermissionMode = "always";
  private pending = new Map<string, { approval: LocalApproval; settle: (allowed: boolean) => void }>();

  mode(id: string | null) { return id === null ? this.draftMode : this.modes.get(id) ?? "always"; }
  bindDraft(id: string) {
    this.setMode(id, this.draftMode);
    this.draftMode = "always";
  }
  setMode(id: string | null, mode: LocalPermissionMode) {
    if (id !== null && (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw new Error("Invalid conversation");
    if (!["always", "conversation", "full"].includes(mode)) throw new Error("Invalid permission mode");
    if (id === null) this.draftMode = mode;
    else { this.modes.set(id, mode); this.granted.delete(id); }
    // Changing a preference never retroactively approves an already pending action.
  }
  list(id: string | null) {
    return [...this.pending.values()].filter(item => item.approval.conversationId === id).map(item => item.approval);
  }
  request(conversationId: string, name: string, detail: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.mode(conversationId) === "full" || (this.mode(conversationId) === "conversation" && this.granted.has(conversationId))) return Promise.resolve(true);
    return new Promise(resolve => {
      const id = randomUUID();
      const settle = (allowed: boolean) => {
        this.pending.delete(id);
        signal.removeEventListener("abort", cancel);
        resolve(allowed && !signal.aborted);
      };
      const cancel = () => settle(false);
      this.pending.set(id, { approval: { id, conversationId, name, detail }, settle });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  respond(conversationId: string, id: string, decision: "deny" | "once" | "conversation") {
    if (!["deny", "once", "conversation"].includes(decision)) throw new Error("Invalid approval decision");
    const item = this.pending.get(id);
    if (!item || item.approval.conversationId !== conversationId) throw new Error("Approval expired");
    if (decision === "conversation") {
      this.modes.set(conversationId, "conversation");
      this.granted.add(conversationId);
    }
    item.settle(decision !== "deny");
  }
  reset() {
    for (const item of this.pending.values()) item.settle(false);
    this.modes.clear();
    this.granted.clear();
    this.draftMode = "always";
  }
}

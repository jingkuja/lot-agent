import { describe, expect, it } from "vitest";
import { ToolApprovals } from "./tool-approvals.js";

const signal = () => new AbortController().signal;
describe("desktop approval policies", () => {
  it("defaults to each action and validates single-use, conversation-bound decisions", async () => {
    const approvals = new ToolApprovals();
    const first = approvals.request("chat", "desktop_bash", "pwd", signal());
    const [pending] = approvals.list("chat");
    expect(approvals.list("other")).toEqual([]);
    expect(() => approvals.respond("other", pending.id, "once")).toThrow("expired");
    expect(() => approvals.respond("chat", pending.id, "full" as any)).toThrow("Invalid");
    approvals.respond("chat", pending.id, "once");
    expect(await first).toBe(true);
    expect(() => approvals.respond("chat", pending.id, "once")).toThrow("expired");
    const second = approvals.request("chat", "desktop_write_file", "file", signal());
    approvals.respond("chat", approvals.list("chat")[0].id, "deny");
    expect(await second).toBe(false);
  });
  it("requires first approval for conversation mode, retains grant across turns and isolates chats", async () => {
    const approvals = new ToolApprovals();
    approvals.setMode(null, "conversation");
    expect(approvals.mode("existing-chat")).toBe("always");
    approvals.bindDraft("chat");
    expect(approvals.mode(null)).toBe("always");
    const first = approvals.request("chat", "desktop_bash", "pwd", signal());
    expect(approvals.list("chat")).toHaveLength(1);
    approvals.respond("chat", approvals.list("chat")[0].id, "conversation");
    expect(await first).toBe(true);
    expect(await approvals.request("chat", "desktop_write_file", "file", signal())).toBe(true);
    const other = approvals.request("other", "desktop_bash", "pwd", signal());
    expect(approvals.list("other")).toHaveLength(1);
    approvals.reset();
    expect(await other).toBe(false);
  });
  it("full access applies only to its chat; narrowing and reset revoke grants", async () => {
    const approvals = new ToolApprovals();
    approvals.setMode("chat", "full");
    expect(await approvals.request("chat", "desktop_bash", "pwd", signal())).toBe(true);
    approvals.setMode("chat", "always");
    const pending = approvals.request("chat", "desktop_bash", "pwd", signal());
    expect(approvals.list("chat")).toHaveLength(1);
    approvals.setMode("chat", "full");
    expect(approvals.list("chat")).toHaveLength(1);
    approvals.reset();
    expect(await pending).toBe(false);
    expect(approvals.mode("chat")).toBe("always");
    expect(() => approvals.setMode("chat", "invalid" as any)).toThrow();
    expect(() => approvals.setMode("../chat", "full")).toThrow();
  });
  it("cancels pending approvals and rejects stale buttons without granting access", async () => {
    const approvals = new ToolApprovals();
    const controller = new AbortController();
    const pending = approvals.request("chat", "desktop_bash", "pwd", controller.signal);
    const id = approvals.list("chat")[0].id;
    controller.abort();
    expect(await pending).toBe(false);
    expect(approvals.list("chat")).toEqual([]);
    expect(() => approvals.respond("chat", id, "conversation")).toThrow("expired");
    approvals.setMode("chat", "full");
    expect(await approvals.request("chat", "desktop_bash", "pwd", controller.signal)).toBe(false);
  });
});

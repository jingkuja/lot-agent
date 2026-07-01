import { describe, it, expect } from "vitest";
import { windowSubAgents, AGENT_TAB_WINDOW } from "./agent-order.js";

const mk = (id: string, sortOrder: number | null = 0) => ({ id, sortOrder });

describe("windowSubAgents", () => {
  const subs = [mk("a", 0), mk("b", 1), mk("c", 2), mk("d", 3)];

  it("pins general out and returns up to AGENT_TAB_WINDOW sub-agents", () => {
    const r = windowSubAgents([mk("general", 0), ...subs], 0, "general");
    expect(r.general?.id).toBe("general");
    expect(r.visible.map((a) => a.id)).toEqual(["a", "b"]);
    expect(AGENT_TAB_WINDOW).toBe(2);
  });

  it("reports canPrev/canNext at the window edges", () => {
    const start = windowSubAgents([mk("general"), ...subs], 0, "general");
    expect(start.canPrev).toBe(false);
    expect(start.canNext).toBe(true);
    const end = windowSubAgents([mk("general"), ...subs], 2, "general");
    expect(end.visible.map((a) => a.id)).toEqual(["c", "d"]);
    expect(end.canPrev).toBe(true);
    expect(end.canNext).toBe(false);
  });

  it("clamps an out-of-range windowStart", () => {
    const r = windowSubAgents([mk("general"), ...subs], 99, "general");
    expect(r.windowStart).toBe(2); // subs.length(4) - WINDOW(2)
    expect(r.visible.map((a) => a.id)).toEqual(["c", "d"]);
  });

  it("auto-follows an active sub-agent past the window end", () => {
    const r = windowSubAgents([mk("general"), ...subs], 0, "d");
    expect(r.visible.map((a) => a.id)).toEqual(["c", "d"]);
    expect(r.windowStart).toBe(2);
  });

  it("auto-follows an active sub-agent before the window start", () => {
    const r = windowSubAgents([mk("general"), ...subs], 2, "a");
    expect(r.visible.map((a) => a.id)).toEqual(["a", "b"]);
    expect(r.windowStart).toBe(0);
  });

  it("sorts sub-agents by sortOrder with nulls last", () => {
    const r = windowSubAgents([mk("general"), mk("x", null), mk("y", 5)], 0, "general");
    expect(r.visible.map((a) => a.id)).toEqual(["y", "x"]);
  });

  it("handles fewer sub-agents than the window", () => {
    const r = windowSubAgents([mk("general"), mk("a", 0)], 0, "general");
    expect(r.visible.map((a) => a.id)).toEqual(["a"]);
    expect(r.canPrev).toBe(false);
    expect(r.canNext).toBe(false);
    expect(r.windowStart).toBe(0);
  });
});

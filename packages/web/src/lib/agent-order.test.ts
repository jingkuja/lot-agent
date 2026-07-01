import { describe, it, expect } from "vitest";
import { splitInstalledAgents, MAX_VISIBLE_SUBAGENTS, windowSubAgents, AGENT_TAB_WINDOW } from "./agent-order.js";

const mk = (id: string, sortOrder: number | null = 0) => ({ id, sortOrder });

describe("splitInstalledAgents", () => {
  it("pulls general out and sorts sub-agents by sortOrder", () => {
    const r = splitInstalledAgents([mk("image", 2), mk("general", 0), mk("video", 1)]);
    expect(r.general?.id).toBe("general");
    expect(r.visible.map((a) => a.id)).toEqual(["video", "image"]);
    expect(r.overflow).toEqual([]);
  });

  it("keeps first 6 sub-agents visible, rest overflow", () => {
    const subs = Array.from({ length: 8 }, (_, i) => mk(`a${i}`, i));
    const r = splitInstalledAgents([mk("general", -1), ...subs]);
    expect(r.visible).toHaveLength(MAX_VISIBLE_SUBAGENTS);
    expect(r.visible.map((a) => a.id)).toEqual(["a0", "a1", "a2", "a3", "a4", "a5"]);
    expect(r.overflow.map((a) => a.id)).toEqual(["a6", "a7"]);
  });

  it("null sortOrder sorts last", () => {
    const r = splitInstalledAgents([mk("general", 0), mk("x", null), mk("y", 5)]);
    expect(r.visible.map((a) => a.id)).toEqual(["y", "x"]);
  });

  it("no general -> general is null", () => {
    const r = splitInstalledAgents([mk("image", 0)]);
    expect(r.general).toBeNull();
    expect(r.visible.map((a) => a.id)).toEqual(["image"]);
  });
});

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

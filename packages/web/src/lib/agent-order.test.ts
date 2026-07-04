import { describe, it, expect } from "vitest";
import { splitInstalledAgents, MAX_VISIBLE_SUBAGENTS, sortedSubAgents } from "./agent-order.js";

const mk = (id: string, sortOrder: number | null = 0) => ({ id, sortOrder });

describe("splitInstalledAgents", () => {
  it("extracts general and keeps the first MAX_VISIBLE_SUBAGENTS visible", () => {
    const subs = Array.from({ length: 8 }, (_, i) => mk(`s${i}`, i));
    const r = splitInstalledAgents([mk("general", 0), ...subs]);
    expect(r.general?.id).toBe("general");
    expect(MAX_VISIBLE_SUBAGENTS).toBe(6);
    expect(r.visible.map((a) => a.id)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
    expect(r.overflow.map((a) => a.id)).toEqual(["s6", "s7"]);
  });

  it("sorts sub-agents by sortOrder with nulls last", () => {
    const r = splitInstalledAgents([mk("general"), mk("x", null), mk("y", 5), mk("z", 1)]);
    expect(r.visible.map((a) => a.id)).toEqual(["z", "y", "x"]);
    expect(r.overflow).toEqual([]);
  });

  it("returns null general and empty overflow when absent", () => {
    const r = splitInstalledAgents([mk("a", 0), mk("b", 1)]);
    expect(r.general).toBeNull();
    expect(r.visible.map((a) => a.id)).toEqual(["a", "b"]);
    expect(r.overflow).toEqual([]);
  });
});

describe("sortedSubAgents", () => {
  it("excludes general and sorts by sortOrder ascending", () => {
    const r = sortedSubAgents([mk("general", 0), mk("b", 2), mk("a", 1)]);
    expect(r.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("puts null sortOrder last", () => {
    const r = sortedSubAgents([mk("x", null), mk("y", 5)]);
    expect(r.map((a) => a.id)).toEqual(["y", "x"]);
  });

  it("returns empty for general-only input", () => {
    expect(sortedSubAgents([mk("general", 0)])).toEqual([]);
  });
});

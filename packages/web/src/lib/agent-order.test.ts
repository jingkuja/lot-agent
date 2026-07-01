import { describe, it, expect } from "vitest";
import { splitInstalledAgents, MAX_VISIBLE_SUBAGENTS } from "./agent-order.js";

const mk = (id: string, sortOrder: number | null) => ({ id, sortOrder });

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

import { describe, it, expect } from "vitest";
import { validateSlides } from "./validation.js";

describe("validateSlides", () => {
  it("passes a well-formed mixed deck", () => {
    expect(
      validateSlides([
        { layout: "cover", title: "T", subtitle: "S" },
        { layout: "stats", title: "数据", items: [{ value: "65%", label: "增长" }, { value: "3x", label: "效率" }] },
        { layout: "compare", title: "对比", left: { title: "旧", bullets: ["a"] }, right: { title: "新", bullets: ["b"] } },
        { layout: "timeline", title: "节奏", items: [{ label: "1" }, { label: "2" }, { label: "3" }] },
        { layout: "quote", title: "", quote: { text: "金句", author: "某人" } },
        { layout: "content", title: "要点", bullets: ["x"] },
      ])
    ).toBeNull();
  });

  it("rejects empty array", () => {
    expect(validateSlides([])).toMatch(/至少一页|non-empty|空/);
  });

  it("rejects unknown layout", () => {
    expect(validateSlides([{ layout: "grid", title: "x" }])).toMatch(/layout/);
  });

  it("requires non-empty title on cover/section/closing", () => {
    expect(validateSlides([{ layout: "section", title: "  " }])).toMatch(/title|标题/);
  });

  it("stats requires 2-4 items each with value+label", () => {
    expect(validateSlides([{ layout: "stats", title: "t", items: [{ value: "1", label: "a" }] }])).toMatch(/stats/);
    expect(validateSlides([{ layout: "stats", title: "t", items: [{ label: "a" }, { label: "b" }] }])).toMatch(/value/);
  });

  it("compare requires both columns with 1-5 bullets", () => {
    expect(validateSlides([{ layout: "compare", title: "t", left: { title: "l", bullets: ["a"] } }])).toMatch(/compare|right/);
  });

  it("timeline requires 3-6 items", () => {
    expect(validateSlides([{ layout: "timeline", title: "t", items: [{ label: "1" }, { label: "2" }] }])).toMatch(/timeline/);
  });

  it("content bullets capped at 8", () => {
    const many = Array.from({ length: 9 }, (_, i) => `b${i}`);
    expect(validateSlides([{ layout: "content", title: "t", bullets: many }])).toMatch(/content|8/);
  });

  it("rejects more than 40 slides", () => {
    const s = Array.from({ length: 41 }, () => ({ layout: "content", title: "t", bullets: ["x"] }));
    expect(validateSlides(s)).toMatch(/40/);
  });
});

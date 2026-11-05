import { describe, expect, it } from "vitest";
import { parseEmployeeName } from "./employee-name.js";

describe("parseEmployeeName", () => {
  it("trims and keeps a valid name", () => {
    expect(parseEmployeeName("  小助 ")).toBe("小助");
    expect(parseEmployeeName("a".repeat(20))).toHaveLength(20);
  });

  it("counts characters rather than UTF-16 units", () => {
    expect(parseEmployeeName("😀".repeat(20))).toHaveLength(40);
    expect(() => parseEmployeeName("😀".repeat(21))).toThrow("1–20");
  });

  it.each(["", "   ", "a".repeat(21), "第一行\n第二行", "带\t制表符"])("rejects %j", (value) => {
    expect(() => parseEmployeeName(value)).toThrow("1–20");
  });

  it("rejects anything that is not text", () => {
    expect(() => parseEmployeeName(3)).toThrow("无效");
  });
});

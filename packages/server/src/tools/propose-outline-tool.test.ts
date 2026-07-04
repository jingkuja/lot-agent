import { describe, it, expect } from "vitest";
import { proposeOutlineTool } from "./propose-outline-tool.js";

describe("propose_outline", () => {
  it("is an endsTurn tool", () => {
    expect(proposeOutlineTool.endsTurn).toBe(true);
    expect(proposeOutlineTool.name).toBe("propose_outline");
  });
  it("validates and returns a waiting placeholder", async () => {
    const r = await proposeOutlineTool.execute({ title: "T", slides: [{ layout: "cover", title: "封面" }] }, {} as any);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("大纲");
  });
  it("rejects invalid slides with validation errorKind", async () => {
    const r = await proposeOutlineTool.execute({ title: "T", slides: [{ layout: "stats", title: "t", items: [{ label: "x" }] }] }, {} as any);
    expect(r.isError).toBe(true);
    expect(r.errorKind).toBe("validation");
  });
});

import { describe, expect, it } from "vitest";
import { InputError } from "./errors.js";
import { parseAssignmentList, parseCreateAssignment, parseCreditLimit, parseDecisionAnswer, parseEventCursor } from "./assignment-validators.js";

describe("creating a task", () => {
  it("needs only a sentence or a file", () => {
    expect(parseCreateAssignment({ goal: "  写方案 " })).toEqual({
      goal: "写方案", mode: "autonomous", attachments: [], modelId: null, creditLimit: null, subtasks: [], subtaskLimit: null,
    });
    expect(parseCreateAssignment({ attachments: [{ assetId: "a1" }] }).attachments).toEqual([{ assetId: "a1", filename: "附件" }]);
    expect(() => parseCreateAssignment({ goal: " " })).toThrow(InputError);
  });

  it("does not trust anything about an attachment but its id and display name", () => {
    expect(parseCreateAssignment({ goal: "x", attachments: [{ assetId: "a1", filename: "手册.pdf", url: "/etc/passwd", mime: "x" }] }).attachments)
      .toEqual([{ assetId: "a1", filename: "手册.pdf" }]);
  });

  it("reads the optional limit", () => {
    expect(parseCreateAssignment({ goal: "x", creditLimit: 500 }).creditLimit).toBe(500);
    expect(parseCreditLimit({ creditLimit: null })).toBeNull();
    expect(() => parseCreditLimit({ creditLimit: 0 })).toThrow(InputError);
    expect(() => parseCreditLimit({ creditLimit: "many" })).toThrow(InputError);
  });
});

describe("the task list query", () => {
  it("normalizes times the browser worked out", () => {
    expect(parseAssignmentList({ from: "2026-11-01T00:00:00+08:00", to: "2026-11-02T00:00:00+08:00" })).toMatchObject({
      from: "2026-10-31T16:00:00.000Z", to: "2026-11-01T16:00:00.000Z", limit: 30,
    });
  });

  it("refuses what cannot be right", () => {
    expect(() => parseAssignmentList({ from: "soon" })).toThrow(InputError);
    expect(() => parseAssignmentList({ from: "2026-11-02T00:00:00Z", to: "2026-11-01T00:00:00Z" })).toThrow(InputError);
    expect(() => parseAssignmentList({ status: "waiting_team" })).toThrow(InputError);
    expect(() => parseAssignmentList({ limit: "0" })).toThrow(InputError);
  });
});

describe("decision input", () => {
  it("takes a mode, and defaults to full autonomy", () => {
    expect(parseCreateAssignment({ goal: "x" }).mode).toBe("autonomous");
    expect(parseCreateAssignment({ goal: "x", mode: "responsive" }).mode).toBe("responsive");
    expect(() => parseCreateAssignment({ goal: "x", mode: "fast" })).toThrow(InputError);
  });

  it("reads an answer, and refuses an unknown choice", () => {
    expect(parseDecisionAnswer({ text: " 华东 " })).toEqual({ text: "华东" });
    expect(parseDecisionAnswer({ choice: "retry" })).toEqual({ choice: "retry" });
    expect(() => parseDecisionAnswer({ choice: "delete" })).toThrow(InputError);
    expect(() => parseDecisionAnswer({ text: "长".repeat(2001) })).toThrow(InputError);
  });

  it("only takes a numeric event cursor", () => {
    expect(parseEventCursor(undefined)).toBeUndefined();
    expect(parseEventCursor("42")).toBe("42");
    expect(() => parseEventCursor("1;drop")).toThrow(InputError);
  });
});

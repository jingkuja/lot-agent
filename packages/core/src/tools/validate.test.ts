import { describe, it, expect } from "vitest";
import { validateToolInput } from "./validate.js";

const schema = {
  type: "object",
  properties: {
    path: { type: "string" },
    count: { type: "number" },
  },
  required: ["path"],
};

describe("validateToolInput", () => {
  it("returns no errors for valid input", () => {
    expect(validateToolInput(schema, { path: "a.txt", count: 3 })).toEqual([]);
  });

  it("flags a missing required field", () => {
    const errors = validateToolInput(schema, { count: 3 });
    expect(errors).toContain('missing required field "path"');
  });

  it("flags a wrong-type field", () => {
    const errors = validateToolInput(schema, { path: "a.txt", count: "three" });
    expect(errors.some((e) => e.includes('field "count"'))).toBe(true);
  });

  it("ignores unknown extra fields", () => {
    expect(validateToolInput(schema, { path: "a.txt", extra: true })).toEqual([]);
  });

  it("treats non-object input as an empty object for property checks", () => {
    const errors = validateToolInput(schema, "not an object");
    expect(errors).toContain('missing required field "path"');
  });
});

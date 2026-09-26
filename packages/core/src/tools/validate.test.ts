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

  it("rejects a non-object root", () => {
    const errors = validateToolInput(schema, "not an object");
    expect(errors.some(e => e.includes("object"))).toBe(true);
  });
});

it("validates nested required, enum, numeric bounds and array length without coercion", () => {
  const nested = { type: "object", additionalProperties: false, properties: {
    items: { type: "array", maxItems: 1, items: { type: "object", required: ["n", "kind"], properties: {
      n: { type: "integer", minimum: 1 }, kind: { enum: ["a", "b"] },
    } } },
  }, required: ["items"] };
  expect(validateToolInput(nested, { items: [{ n: 1, kind: "a" }] })).toEqual([]);
  for (const invalid of [null, { items: [{}] }, { items: [{ n: "1", kind: "a" }] }, { items: [{ n: 0, kind: "c" }] }, { items: [{ n: 1, kind: "a" }, { n: 2, kind: "b" }] }]) {
    expect(validateToolInput(nested, invalid).length).toBeGreaterThan(0);
  }
});

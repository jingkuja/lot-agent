import { expect, it } from "vitest";
import { factInput, canonicalFactKey, mergeFactMemory } from "./values.js";
it("validates typed values and valid-time intervals with private defaults", () => {
  expect(factInput.parse({ key: "preferred_language", value: "中文" }).shareWithApi).toBe(false);
  expect(() => factInput.parse({ key: "age", type: "number", value: "20" })).toThrow();
  expect(() => factInput.parse({ key: "name", value: "A", validFrom: "2026-02-02T00:00:00Z", validUntil: "2026-01-01T00:00:00Z" })).toThrow();
  expect(canonicalFactKey("Name")).toBe("display_name");
});
it("does not resurface expired/deactivated confirmed keys from legacy memory", () => {
  const legacy = [{ key: "name", value: "A", tier: "user" as const, createdAt: 1 }, { key: "hobby", value: "swimming", tier: "user" as const, createdAt: 2 }];
  expect(mergeFactMemory(legacy, [{ key: "display_name", value: "B", current: true, updatedAt: 3 }]).map((row) => row.value)).toEqual(["B", "swimming"]);
  expect(mergeFactMemory(legacy, [{ key: "display_name", value: "B", current: false, updatedAt: 3 }]).map((row) => row.value)).toEqual(["swimming"]);
});

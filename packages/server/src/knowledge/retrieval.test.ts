import { expect, it } from "vitest";
import { fuseRanks } from "./retrieval.js";
import { lexicalText, indexProfile } from "./ingestion/profile.js";
it("fuses stable chunk identities rather than scores from incomparable modes", () => {
  expect(fuseRanks([[{ id: "a", value: 0.3 }, { id: "b", value: 0.2 }], [{ id: "b", value: 0.99 }]])[0].id).toBe("b");
  expect(fuseRanks([[{ id: "a", value: 1 }, { id: "a", value: 1 }]])).toHaveLength(1);
});
it("segments Chinese and preserves identifiers and a versioned immutable profile", () => {
  const text = lexicalText("离线查看资料 AB-123 2026");
  expect(text).not.toContain("离线查看资料"); expect(text).toContain("查看"); expect(text).toContain("ab-123"); expect(text).toContain("2026");
  expect(indexProfile("https://gateway/v1").dictionaryVersion).toContain(process.versions.icu);
  expect(indexProfile("https://other/v1").id).not.toBe(indexProfile("https://gateway/v1").id);
  expect(() => indexProfile("https://user:password@gateway/v1")).toThrow();
});

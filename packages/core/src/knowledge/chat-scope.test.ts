import { expect, it } from "vitest";
import { parseChatSourceTypes } from "./chat-scope.js";
it("keeps legacy/default chat limited to documents and notes", () => {
  expect(parseChatSourceTypes(undefined)).toEqual(["document", "note"]);
});
it("accepts explicit media and fact scope and rejects unrecognized or empty types", () => {
  expect(parseChatSourceTypes(["bookmark", "image", "profile_fact", "image"])).toEqual(["bookmark", "image", "profile_fact"]);
  for (const invalid of [[], ["other"], ["constructor"], "image", null]) expect(() => parseChatSourceTypes(invalid)).toThrow();
});

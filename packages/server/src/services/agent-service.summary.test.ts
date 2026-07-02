import { describe, it, expect } from "vitest";
import { readPersistedSummary } from "./agent-service.js";

describe("readPersistedSummary", () => {
  it("reads a valid contextSummary from conversation metadata", () => {
    expect(
      readPersistedSummary({ contextSummary: { count: 6, text: "note" } })
    ).toEqual({ count: 6, text: "note" });
  });

  it("returns undefined for missing or malformed state", () => {
    expect(readPersistedSummary(undefined)).toBeUndefined();
    expect(readPersistedSummary({})).toBeUndefined();
    expect(readPersistedSummary({ contextSummary: null })).toBeUndefined();
    expect(
      readPersistedSummary({ contextSummary: { count: 0, text: "note" } })
    ).toBeUndefined();
    expect(
      readPersistedSummary({ contextSummary: { count: "6", text: "note" } })
    ).toBeUndefined();
    expect(
      readPersistedSummary({ contextSummary: { count: 6, text: "" } })
    ).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import { normalizeApiKeyEntries } from "./api-key-entry.js";

describe("normalizeApiKeyEntries", () => {
  it("wraps bare strings", () => {
    expect(normalizeApiKeyEntries(["sk-A", "sk-B"])).toEqual([
      { apiKey: "sk-A" },
      { apiKey: "sk-B" },
    ]);
  });

  it("maps tokenhub wire objects (api_key snake_case) with name/group", () => {
    expect(
      normalizeApiKeyEntries([
        { api_key: "sk-A", name: "开放API密钥", group: "" },
        { api_key: "sk-B", name: "test", group: "agent2_demo" },
      ])
    ).toEqual([
      { apiKey: "sk-A", name: "开放API密钥" },
      { apiKey: "sk-B", name: "test", group: "agent2_demo" },
    ]);
  });

  it("maps our own persisted objects (apiKey camelCase)", () => {
    expect(normalizeApiKeyEntries([{ apiKey: "sk-A", name: "n", group: "g" }])).toEqual([
      { apiKey: "sk-A", name: "n", group: "g" },
    ]);
  });

  it("omits name/group when empty or absent", () => {
    expect(normalizeApiKeyEntries([{ api_key: "sk-A" }])).toEqual([{ apiKey: "sk-A" }]);
    expect(normalizeApiKeyEntries([{ api_key: "sk-A", name: "", group: "" }])).toEqual([
      { apiKey: "sk-A" },
    ]);
  });

  it("drops entries with no usable key string instead of throwing", () => {
    expect(normalizeApiKeyEntries([{ name: "orphan" }, "sk-OK", 42, null])).toEqual([
      { apiKey: "sk-OK" },
    ]);
  });

  it("returns [] for non-array input", () => {
    expect(normalizeApiKeyEntries(null)).toEqual([]);
    expect(normalizeApiKeyEntries(undefined)).toEqual([]);
    expect(normalizeApiKeyEntries("sk-A")).toEqual([]);
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  buildExtractionMessages,
  parseExtraction,
  applyExtraction,
} from "./extraction.js";
import type { PersistentMemoryAdapter, MemoryEntry } from "./store.js";

describe("buildExtractionMessages", () => {
  it("returns a system + user message containing the turn and existing keys", () => {
    const existing: MemoryEntry[] = [
      { key: "preferred_language", value: "简体中文", tier: "user", createdAt: 0 },
    ];
    const msgs = buildExtractionMessages(
      { userMessage: "我叫小明", assistantText: "你好小明" },
      existing
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
    const user = msgs[1].content as string;
    expect(user).toContain("我叫小明");
    expect(user).toContain("你好小明");
    expect(user).toContain("preferred_language");
  });

  it("is valid with no existing memories", () => {
    const msgs = buildExtractionMessages({ userMessage: "hi", assistantText: "hello" }, []);
    expect(msgs).toHaveLength(2);
    expect(typeof msgs[1].content).toBe("string");
  });
});

describe("parseExtraction", () => {
  it("parses plain JSON", () => {
    const r = parseExtraction('{"upserts":[{"key":"a","value":"b"}],"deletes":["c"]}');
    expect(r).toEqual({ upserts: [{ key: "a", value: "b" }], deletes: ["c"] });
  });

  it("parses fenced ```json blocks", () => {
    const r = parseExtraction('```json\n{"upserts":[],"deletes":[]}\n```');
    expect(r).toEqual({ upserts: [], deletes: [] });
  });

  it("returns empty ops on garbage", () => {
    expect(parseExtraction("not json at all")).toEqual({ upserts: [], deletes: [] });
  });

  it("drops malformed upserts and non-string deletes", () => {
    const r = parseExtraction(
      '{"upserts":[{"key":"a","value":"b"},{"key":"x"},"junk"],"deletes":["ok",5,null]}'
    );
    expect(r).toEqual({ upserts: [{ key: "a", value: "b" }], deletes: ["ok"] });
  });

  it("defaults missing arrays to empty", () => {
    expect(parseExtraction("{}")).toEqual({ upserts: [], deletes: [] });
  });
});

describe("applyExtraction", () => {
  it("deletes then upserts via the adapter", async () => {
    const calls: string[] = [];
    const adapter: PersistentMemoryAdapter = {
      get: async () => undefined,
      set: async (_u, k) => { calls.push(`set:${k}`); },
      delete: async (_u, k) => { calls.push(`del:${k}`); },
      list: async () => [],
      search: async () => [],
    };
    await applyExtraction(adapter, "u1", {
      upserts: [{ key: "a", value: "1" }],
      deletes: ["old"],
    });
    expect(calls).toEqual(["del:old", "set:a"]);
  });

  it("continues after a single op failure", async () => {
    const set = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const adapter: PersistentMemoryAdapter = {
      get: async () => undefined,
      set,
      delete: async () => {},
      list: async () => [],
      search: async () => [],
    };
    await applyExtraction(adapter, "u1", {
      upserts: [{ key: "a", value: "1" }, { key: "b", value: "2" }],
      deletes: [],
    });
    expect(set).toHaveBeenCalledTimes(2);
  });
});

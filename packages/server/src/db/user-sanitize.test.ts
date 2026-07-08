import { describe, it, expect } from "vitest";
import { toPublicUser, maskKey } from "./user-sanitize.js";
import type { StoredUser } from "./database.js";

const base: StoredUser = {
  id: "u1", email: "e@x", name: "138", created_at: "t",
  external_user_id: 2, username: "138", api_key: null, api_keys: null,
};

describe("maskKey", () => {
  it("masks the middle of a long key", () => {
    expect(maskKey("sk-7kLcT3xuy7mcxId5X5jemZUrwKnTv15WB3unKkApNNtx5Uir")).toBe("sk-7kL***5Uir");
  });
  it("fully masks short keys", () => {
    expect(maskKey("sk-abc")).toBe("***");
  });
});

describe("toPublicUser", () => {
  it("returns masked keys + name/group + active index, never the raw key or email", () => {
    const u = {
      ...base,
      api_key: "sk-BBBBBBBBBBBBBB",
      api_keys: [
        { apiKey: "sk-AAAAAAAAAAAAAA", name: "开放API密钥", group: "" },
        { apiKey: "sk-BBBBBBBBBBBBBB", name: "test", group: "agent2_demo" },
      ],
    };
    const pub = toPublicUser(u);
    expect(pub).toEqual({
      id: "u1", name: "138", username: "138",
      apiKeys: [
        { key: "sk-AAA***AAAA", name: "开放API密钥" },
        { key: "sk-BBB***BBBB", name: "test", group: "agent2_demo" },
      ],
      activeKeyIndex: 1,
    });
    expect(JSON.stringify(pub)).not.toContain("sk-BBBBBBBBBBBBBB");
    expect(JSON.stringify(pub)).not.toContain("e@x");
  });

  it("falls back to the masked key as name when tokenhub gave no name", () => {
    const u = { ...base, api_key: "sk-AAAAAAAAAAAAAA", api_keys: [{ apiKey: "sk-AAAAAAAAAAAAAA" }] };
    expect(toPublicUser(u).apiKeys).toEqual([{ key: "sk-AAA***AAAA", name: "sk-AAA***AAAA" }]);
  });

  it("handles legacy bare-string api_keys rows the same way", () => {
    const u = { ...base, api_key: "sk-AAAAAAAAAAAAAA", api_keys: ["sk-AAAAAAAAAAAAAA"] };
    expect(toPublicUser(u).apiKeys).toEqual([{ key: "sk-AAA***AAAA", name: "sk-AAA***AAAA" }]);
  });

  it("activeKeyIndex is -1 when there is no key", () => {
    expect(toPublicUser(base)).toMatchObject({ apiKeys: [], activeKeyIndex: -1 });
  });

  it("activeKeyIndex is -1 when api_key is not in the list", () => {
    const u = { ...base, api_key: "sk-ZZZZZZZZZZZZZZ", api_keys: [{ apiKey: "sk-AAAAAAAAAAAAAA" }] };
    expect(toPublicUser(u).activeKeyIndex).toBe(-1);
  });
});

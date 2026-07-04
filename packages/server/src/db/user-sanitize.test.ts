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
  it("returns masked keys + active index, never the raw key or email", () => {
    const u = { ...base, api_key: "sk-BBBBBBBBBBBBBB", api_keys: ["sk-AAAAAAAAAAAAAA", "sk-BBBBBBBBBBBBBB"] };
    const pub = toPublicUser(u);
    expect(pub).toEqual({
      id: "u1", name: "138", username: "138",
      apiKeys: ["sk-AAA***AAAA", "sk-BBB***BBBB"],
      activeKeyIndex: 1,
    });
    expect(JSON.stringify(pub)).not.toContain("sk-BBBBBBBBBBBBBB");
    expect(JSON.stringify(pub)).not.toContain("e@x");
  });
  it("activeKeyIndex is -1 when there is no key", () => {
    expect(toPublicUser(base)).toMatchObject({ apiKeys: [], activeKeyIndex: -1 });
  });
  it("activeKeyIndex is -1 when api_key is not in the list", () => {
    const u = { ...base, api_key: "sk-ZZZZZZZZZZZZZZ", api_keys: ["sk-AAAAAAAAAAAAAA"] };
    expect(toPublicUser(u).activeKeyIndex).toBe(-1);
  });
});

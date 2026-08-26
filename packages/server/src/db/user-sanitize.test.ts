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
  it("returns a masked phone without exposing the raw value", () => {
    const pub = toPublicUser({ ...base, phone: "13800138000" });
    expect(pub.phone).toBe("138****8000");
    expect(JSON.stringify(pub)).not.toContain("13800138000");
  });

  it("never exposes ordinary keys, active selection, raw keys, or email", () => {
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
      phone: null,
      apiKeys: [],
      activeKeyIndex: -1,
    });
    expect(JSON.stringify(pub)).not.toContain("sk-BBBBBBBBBBBBBB");
    expect(JSON.stringify(pub)).not.toContain("e@x");
  });

  it("does not expose a key when tokenhub gave no name", () => {
    const u = { ...base, api_key: "sk-AAAAAAAAAAAAAA", api_keys: [{ apiKey: "sk-AAAAAAAAAAAAAA" }] };
    expect(toPublicUser(u).apiKeys).toEqual([]);
  });

  it("handles legacy bare-string api_keys rows the same way", () => {
    const u = { ...base, api_key: "sk-AAAAAAAAAAAAAA", api_keys: ["sk-AAAAAAAAAAAAAA"] };
    expect(toPublicUser(u).apiKeys).toEqual([]);
  });

  it("activeKeyIndex is -1 when there is no key", () => {
    expect(toPublicUser(base)).toMatchObject({ apiKeys: [], activeKeyIndex: -1 });
  });

  it("activeKeyIndex is -1 when api_key is not in the list", () => {
    const u = { ...base, api_key: "sk-ZZZZZZZZZZZZZZ", api_keys: [{ apiKey: "sk-AAAAAAAAAAAAAA" }] };
    expect(toPublicUser(u).activeKeyIndex).toBe(-1);
  });

  it("never exposes the managed credential or legacy ordinary keys after provisioning", () => {
    const pub = toPublicUser({
      ...base,
      managed_api_key: "managed-super-secret",
      api_key: "ordinary-active",
      api_keys: [{ apiKey: "ordinary-active", name: "ordinary" }],
    });
    expect(pub).toMatchObject({ apiKeys: [], activeKeyIndex: -1 });
    expect(JSON.stringify(pub)).not.toContain("managed-super-secret");
    expect(JSON.stringify(pub)).not.toContain("ordinary-active");
  });
});

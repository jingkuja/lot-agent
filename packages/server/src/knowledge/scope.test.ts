import { describe, expect, it, vi } from "vitest";
import { resolveKnowledgeScope, type VerifiedKnowledgeCaller } from "./scope.js";

const session: VerifiedKnowledgeCaller = { kind: "session", userId: "u1", sessionId: "s1" };
const key: VerifiedKnowledgeCaller = { kind: "access_key", userId: "u1", keyId: "key1", application: "Lot Bot",
  scopes: ["retrieval:read"], collectionIds: ["a", "b"], expiresAt: null, revokedAt: null };
const owned = vi.fn(async (_owner: string, ids: readonly string[]) => ids.filter((id) => id !== "foreign"));
describe("knowledge authorization scope", () => {
  it("uses verified owner and explicit requested collections", async () => {
    const result = await resolveKnowledgeScope(session, ["a"], "retrieval:read", owned);
    expect(result).toMatchObject({ ownerId: "u1", collectionIds: ["a"], callerKind: "session" });
    expect(owned).toHaveBeenLastCalledWith("u1", ["a"]);
  });
  it("restricts internal requests to their task grant", async () => {
    const internal: VerifiedKnowledgeCaller = { kind: "internal", userId: "u1", collectionIds: ["a"] };
    await expect(resolveKnowledgeScope(internal, ["b"], "retrieval:read", owned)).rejects.toMatchObject({ status: 404 });
  });
  it("does not broaden key grants or silently accept a partial intersection", async () => {
    await expect(resolveKnowledgeScope(key, ["a", "c"], "retrieval:read", owned)).rejects.toMatchObject({ status: 404 });
    await expect(resolveKnowledgeScope(session, ["a", "foreign"], "retrieval:read", owned)).rejects.toMatchObject({ status: 404 });
    await expect(resolveKnowledgeScope(key, ["b"], "retrieval:read", owned)).resolves.toMatchObject({ collectionIds: ["b"], keyId: "key1" });
  });
  it("rejects missing scope, revocation and expiry including the exact expiry instant", async () => {
    await expect(resolveKnowledgeScope(key, ["a"], "assets:read", owned)).rejects.toMatchObject({ status: 403 });
    for (const change of [{ revokedAt: "2026-01-01T00:00:00Z" }, { expiresAt: "2026-09-23T00:00:00Z" }, { expiresAt: "invalid" }]) {
      await expect(resolveKnowledgeScope({ ...key, ...change }, ["a"], "retrieval:read", owned,
        new Date("2026-09-23T00:00:00Z"))).rejects.toMatchObject({ status: 401 });
    }
  });
  it("rejects empty and duplicate selections; dependency failure is not an empty result", async () => {
    for (const ids of [[], ["a", "a"]]) {
      await expect(resolveKnowledgeScope(session, ids, "retrieval:read", owned)).rejects.toMatchObject({ status: 400 });
    }
    await expect(resolveKnowledgeScope(session, ["a"], "retrieval:read", async () => { throw new Error("db unavailable"); })).rejects.toThrow("db unavailable");
  });
});

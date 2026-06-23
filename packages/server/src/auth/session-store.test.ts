import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "./session-store.js";
import type { DB } from "../db/database.js";

// ── In-memory mock DB for session methods ──

interface MockSession {
  user_id: string;
  expires_at: string;
}

function makeMockDB(): Pick<DB, "createSession" | "getSessionByToken" | "touchSession" | "deleteSession"> {
  const store = new Map<string, MockSession>();

  return {
    async createSession(userId: string, token: string, expiresAt: Date): Promise<void> {
      store.set(token, { user_id: userId, expires_at: expiresAt.toISOString() });
    },
    async getSessionByToken(token: string) {
      return store.get(token) ?? null;
    },
    async touchSession(_token: string): Promise<void> {
      // no-op in tests
    },
    async deleteSession(token: string): Promise<void> {
      store.delete(token);
    },
  };
}

describe("SessionStore", () => {
  let sessions: SessionStore;

  beforeEach(() => {
    sessions = new SessionStore(makeMockDB() as unknown as DB);
  });

  it("two createSession calls for the same user both resolve", async () => {
    const token1 = await sessions.createSession("user-A");
    const token2 = await sessions.createSession("user-A");

    expect(token1).not.toBe(token2);

    const s1 = await sessions.resolve(token1);
    const s2 = await sessions.resolve(token2);

    expect(s1).not.toBeNull();
    expect(s1?.userId).toBe("user-A");
    expect(s2).not.toBeNull();
    expect(s2?.userId).toBe("user-A");
  });

  it("revoke makes that token resolve to null but other token still works", async () => {
    const token1 = await sessions.createSession("user-A");
    const token2 = await sessions.createSession("user-A");

    await sessions.revoke(token1);

    const s1 = await sessions.resolve(token1);
    const s2 = await sessions.resolve(token2);

    expect(s1).toBeNull();
    expect(s2).not.toBeNull();
    expect(s2?.userId).toBe("user-A");
  });

  it("expired session resolves to null", async () => {
    const mockDB = makeMockDB();
    // Override createSession to store an already-expired expiry
    const originalCreate = mockDB.createSession.bind(mockDB);
    mockDB.createSession = async (userId, token, _expiresAt) => {
      // store with expiry in the past
      const pastExpiry = new Date(Date.now() - 1000);
      await originalCreate(userId, token, pastExpiry);
    };

    const expiredStore = new SessionStore(mockDB as unknown as DB);
    const token = await expiredStore.createSession("user-B");
    const result = await expiredStore.resolve(token);
    expect(result).toBeNull();
  });

  it("resolve returns null for unknown token", async () => {
    const result = await sessions.resolve("nonexistent-token");
    expect(result).toBeNull();
  });
});

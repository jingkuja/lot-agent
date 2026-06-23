import { randomBytes } from "node:crypto";
import type { DB } from "../db/database.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class SessionStore {
  constructor(private readonly db: DB) {}

  async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.createSession(userId, token, expiresAt);
    return token;
  }

  async resolve(token: string): Promise<{ userId: string } | null> {
    const row = await this.db.getSessionByToken(token);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    // best-effort last_seen_at update
    this.db.touchSession(token).catch(() => {});
    return { userId: row.user_id };
  }

  async revoke(token: string): Promise<void> {
    await this.db.deleteSession(token);
  }
}

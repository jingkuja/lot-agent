/**
 * Three-tier memory system:
 *   Ephemeral — in-memory, cleared per agent run (tool intermediate results)
 *   Session   — in-memory, 20-min TTL (conversation state, pending confirmations)
 *   User      — PostgreSQL, permanent (user preferences, historical summaries)
 */

export type MemoryTier = "ephemeral" | "session" | "user";

export interface MemoryEntry {
  key: string;
  value: string;
  tier: MemoryTier;
  /** Optional metadata (tags, source, etc.) */
  meta?: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
}

export interface MemoryStore {
  get(tier: MemoryTier, key: string): string | undefined;
  set(tier: MemoryTier, key: string, value: string, ttlMs?: number): void;
  delete(tier: MemoryTier, key: string): void;
  has(tier: MemoryTier, key: string): boolean;
  keys(tier: MemoryTier): string[];
  clear(tier: MemoryTier): void;
  /** Get all entries for a tier (for prompt injection) */
  dump(tier: MemoryTier): MemoryEntry[];
  /** Cleanup expired entries */
  gc(): void;
}

// ── In-Memory Tier (Ephemeral + Session) ──

class InMemoryTier {
  private store = new Map<string, MemoryEntry>();

  get(key: string): string | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: string, meta?: Record<string, unknown>, ttlMs?: number): void {
    this.store.set(key, {
      key,
      value,
      tier: "ephemeral", // will be overridden by caller
      meta,
      createdAt: Date.now(),
      expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
    });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  keys(): string[] {
    this.gc();
    return [...this.store.keys()];
  }

  dump(): MemoryEntry[] {
    this.gc();
    return [...this.store.values()];
  }

  clear(): void {
    this.store.clear();
  }

  gc(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}

// ── Persistent Tier (User memory via callback) ──

export interface PersistentMemoryAdapter {
  get(userId: string, key: string): Promise<string | undefined>;
  set(userId: string, key: string, value: string, meta?: Record<string, unknown>): Promise<void>;
  delete(userId: string, key: string): Promise<void>;
  list(userId: string): Promise<MemoryEntry[]>;
  search(userId: string, query: string): Promise<MemoryEntry[]>;
}

// ── Combined Memory Store ──

const SESSION_TTL_MS = 20 * 60 * 1000; // 20 minutes

export class AgentMemoryStore implements MemoryStore {
  private ephemeral = new InMemoryTier();
  private session = new InMemoryTier();
  private persistent?: PersistentMemoryAdapter;
  private userId?: string;

  constructor(opts?: { persistent?: PersistentMemoryAdapter; userId?: string }) {
    this.persistent = opts?.persistent;
    this.userId = opts?.userId;
  }

  get(tier: MemoryTier, key: string): string | undefined {
    switch (tier) {
      case "ephemeral":
        return this.ephemeral.get(key);
      case "session":
        return this.session.get(key);
      case "user":
        // User memory is async-only; for sync access, check a local cache
        return undefined;
    }
  }

  set(tier: MemoryTier, key: string, value: string, ttlMs?: number): void {
    switch (tier) {
      case "ephemeral":
        this.ephemeral.set(key, value, undefined, ttlMs);
        break;
      case "session":
        this.session.set(key, value, undefined, ttlMs ?? SESSION_TTL_MS);
        break;
      case "user":
        // Fire-and-forget for sync API; use async methods for guaranteed persistence
        if (this.persistent && this.userId) {
          this.persistent.set(this.userId, key, value).catch(() => {});
        }
        break;
    }
  }

  delete(tier: MemoryTier, key: string): void {
    switch (tier) {
      case "ephemeral":
        this.ephemeral.delete(key);
        break;
      case "session":
        this.session.delete(key);
        break;
      case "user":
        if (this.persistent && this.userId) {
          this.persistent.delete(this.userId, key).catch(() => {});
        }
        break;
    }
  }

  has(tier: MemoryTier, key: string): boolean {
    switch (tier) {
      case "ephemeral":
        return this.ephemeral.has(key);
      case "session":
        return this.session.has(key);
      case "user":
        return false; // async-only
    }
  }

  keys(tier: MemoryTier): string[] {
    switch (tier) {
      case "ephemeral":
        return this.ephemeral.keys();
      case "session":
        return this.session.keys();
      case "user":
        return [];
    }
  }

  dump(tier: MemoryTier): MemoryEntry[] {
    switch (tier) {
      case "ephemeral":
        return this.ephemeral.dump().map((e) => ({ ...e, tier: "ephemeral" as const }));
      case "session":
        return this.session.dump().map((e) => ({ ...e, tier: "session" as const }));
      case "user":
        return [];
    }
  }

  clear(tier: MemoryTier): void {
    switch (tier) {
      case "ephemeral":
        this.ephemeral.clear();
        break;
      case "session":
        this.session.clear();
        break;
      case "user":
        // Cannot clear all user memory without listing
        break;
    }
  }

  gc(): void {
    this.ephemeral.gc();
    this.session.gc();
  }

  /** Clear ephemeral memory (call at start of each agent run) */
  clearEphemeral(): void {
    this.ephemeral.clear();
  }

  // ── Async User Memory API ──

  async getUserMemory(key: string): Promise<string | undefined> {
    if (!this.persistent || !this.userId) return undefined;
    return this.persistent.get(this.userId, key);
  }

  async setUserMemory(key: string, value: string, meta?: Record<string, unknown>): Promise<void> {
    if (!this.persistent || !this.userId) return;
    await this.persistent.set(this.userId, key, value, meta);
  }

  async listUserMemory(): Promise<MemoryEntry[]> {
    if (!this.persistent || !this.userId) return [];
    return this.persistent.list(this.userId);
  }

  async searchUserMemory(query: string): Promise<MemoryEntry[]> {
    if (!this.persistent || !this.userId) return [];
    return this.persistent.search(this.userId, query);
  }

  /** Format all memory tiers into a prompt section */
  formatForPrompt(): string {
    const parts: string[] = [];

    // Session memory
    const sessionEntries = this.dump("session");
    if (sessionEntries.length > 0) {
      parts.push("[Session Memory]");
      for (const e of sessionEntries) {
        parts.push(`- ${e.key}: ${e.value}`);
      }
    }

    // Ephemeral memory (usually not in prompt, but available)
    const ephemeralEntries = this.dump("ephemeral");
    if (ephemeralEntries.length > 0) {
      parts.push("[Working Memory]");
      for (const e of ephemeralEntries) {
        parts.push(`- ${e.key}: ${e.value}`);
      }
    }

    return parts.join("\n");
  }
}

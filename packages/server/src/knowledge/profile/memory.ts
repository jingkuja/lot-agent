import { PgMemoryAdapter, type MemoryEntry, type PersistentMemoryAdapter } from "@lot-agent/core";
import { KnowledgeFacts } from "./repository.js";
import { canonicalFactKey, mergeFactMemory } from "./values.js";
/** Confirmed keys, including tombstones, suppress conflicting legacy memory. Automatic writes are suggestions. */
export class FactAwareMemory implements PersistentMemoryAdapter {
  constructor(private readonly legacy: PgMemoryAdapter, private readonly facts: KnowledgeFacts) {}
  async list(owner: string): Promise<MemoryEntry[]> {
    const [legacy, facts] = await Promise.all([this.legacy.list(owner), this.facts.list(owner)]);
    return mergeFactMemory(legacy, facts.map((row) => ({ key: row.key, value: row.value, current: row.current, updatedAt: row.updated_at.getTime() })));
  }
  async get(owner: string, key: string) { return (await this.list(owner)).find((entry) => canonicalFactKey(entry.key) === canonicalFactKey(key))?.value; }
  async search(owner: string, query: string) { const needle = query.toLowerCase(); return (await this.list(owner)).filter((entry) => `${entry.key} ${entry.value}`.toLowerCase().includes(needle)).slice(0, 20); }
  async set(owner: string, key: string, value: string) { await this.facts.suggest(owner, { upserts: [{ key, value }], deletes: [] }); }
  async delete(owner: string, key: string) { await this.facts.suggest(owner, { upserts: [], deletes: [key] }); }
}

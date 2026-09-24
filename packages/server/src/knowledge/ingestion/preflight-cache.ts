/** Short-lived non-secret capability/rate metadata only; never caches quota, credentials or usage. */
export class PreflightCache<T> {
  private entries = new Map<string, { expires: number; value: Promise<T> }>();
  constructor(readonly ttlMs = 30_000) {}
  async get(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
    const existing = this.entries.get(key); if (existing && existing.expires > now) return existing.value;
    if (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value!);
    const entry = { expires: now + this.ttlMs, value: load() }; this.entries.set(key, entry);
    try { return await entry.value; } catch (error) { if (this.entries.get(key) === entry) this.entries.delete(key); throw error; }
  }
}

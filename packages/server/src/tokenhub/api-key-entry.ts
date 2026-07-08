/** One usable model-call key for a tokenhub account. `name`/`group` are
 * display-only labels tokenhub attaches to the key; both optional. */
export interface RawApiKeyEntry {
  apiKey: string;
  name?: string;
  group?: string;
}

type WireEntry = { api_key?: unknown; apiKey?: unknown; name?: unknown; group?: unknown };

/** Normalizes one element of a tokenhub `api_keys` array — or of the JSONB
 * array we've persisted ourselves in an earlier/newer shape — into
 * RawApiKeyEntry. Accepts a bare string, a wire object (`api_key` snake_case),
 * or our own persisted object (`apiKey` camelCase). Entries with no usable
 * key string are dropped rather than throwing, since one malformed entry
 * shouldn't break login or key listing. */
export function normalizeApiKeyEntries(raw: unknown): RawApiKeyEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RawApiKeyEntry[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push({ apiKey: entry });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as WireEntry;
    const apiKey = typeof e.apiKey === "string" ? e.apiKey : typeof e.api_key === "string" ? e.api_key : null;
    if (!apiKey) continue;
    const name = typeof e.name === "string" && e.name ? e.name : undefined;
    const group = typeof e.group === "string" && e.group ? e.group : undefined;
    out.push({ apiKey, ...(name ? { name } : {}), ...(group ? { group } : {}) });
  }
  return out;
}

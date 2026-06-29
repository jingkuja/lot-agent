import type { MemoryEntry } from "./store.js";

/**
 * Backend for persisting the session memory tier across requests,
 * keyed by conversationId. Implemented in server with Redis.
 */
export interface SessionMemoryBackend {
  load(conversationId: string): Promise<MemoryEntry[]>;
  save(conversationId: string, entries: MemoryEntry[]): Promise<void>;
}

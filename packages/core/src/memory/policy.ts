/** Tool names that indicate an agent can use the memory system. */
const MEMORY_TOOL_NAMES = [
  "memory_read",
  "memory_write",
  "memory_list",
  "memory_delete",
];

/**
 * Whether the agent's tool whitelist grants access to memory tools.
 * `undefined` means "all tools allowed" → true.
 */
export function hasMemoryTools(names?: string[]): boolean {
  if (!names) return true;
  return names.some((n) => MEMORY_TOOL_NAMES.includes(n));
}

// NOTE: injection is gated off via hasMemoryTools() — no agent currently
// whitelists the memory tools, so this prompt is not injected. Kept for
// re-enablement.
/** Strategy block injected into the system prompt for memory-capable agents. */
export const MEMORY_POLICY_PROMPT = `[Memory policy]
Access three memory tiers with memory_read / memory_write / memory_list / memory_delete:
- user (persistent): lasting facts and stable preferences across conversations, such as preferred name/language, industry/brand context and lasting constraints. Store only explicit or reliably inferable stable facts. Never store one-off requests, transient context, passwords or payment information.
- session: state useful only in this conversation, such as pending confirmations or intermediate decisions. Expires after 20 minutes of inactivity.
- ephemeral: temporary results within one turn; no manual management needed.

Before writing, read/list existing entries. Update the same key for the same fact rather than creating duplicates. Overwrite or delete corrected, changed or stale memories. Use stable English snake_case keys, such as preferred_language or brand_name. Store nothing without lasting value.`;

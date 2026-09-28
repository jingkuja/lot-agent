import type { Message } from "../types/index.js";
import type { MemoryEntry, PersistentMemoryAdapter } from "./store.js";

export interface MemoryTurn {
  userMessage: string;
  assistantText: string;
}

export interface MemoryExtraction {
  upserts: Array<{ key: string; value: string }>;
  deletes: string[];
}

const SYSTEM_PROMPT = `You extract reusable user facts and stable preferences from one conversation turn: preferred name/language, industry/brand background and lasting constraints.
Do not extract one-off requests, transient context or sensitive information such as passwords/payment details.
Given existing memories, return:
- upserts: new or changed facts, using stable English snake_case keys such as preferred_language or brand_name. Preserve the user's language in values.
- deletes: existing keys corrected, contradicted or clearly obsolete.
When there is nothing to remember, return empty arrays.
Output only JSON, with no explanation or Markdown: {"upserts":[{"key":"","value":""}],"deletes":[""]}`;

export function buildExtractionMessages(
  turn: MemoryTurn,
  existing: MemoryEntry[]
): Message[] {
  const existingText = existing.length
    ? existing.map((e) => `- ${e.key}: ${e.value}`).join("\n")
    : "(none)";
  const userContent =
    `[Existing memories]\n${existingText}\n\n` +
    `[Current turn]\nUser: ${turn.userMessage}\nAssistant: ${turn.assistantText}`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

export function parseExtraction(raw: string): MemoryExtraction {
  const empty: MemoryExtraction = { upserts: [], deletes: [] };
  if (!raw) return empty;
  // Strip code fences and surrounding noise; grab the outermost JSON object.
  const fenced = raw.replace(/```json/gi, "```");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return empty;
  let obj: unknown;
  try {
    obj = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (typeof obj !== "object" || obj === null) return empty;
  const o = obj as Record<string, unknown>;
  const upserts = Array.isArray(o.upserts)
    ? o.upserts.filter(
        (u): u is { key: string; value: string } =>
          typeof u === "object" &&
          u !== null &&
          typeof (u as Record<string, unknown>).key === "string" &&
          typeof (u as Record<string, unknown>).value === "string"
      )
    : [];
  const deletes = Array.isArray(o.deletes)
    ? o.deletes.filter((d): d is string => typeof d === "string")
    : [];
  return { upserts, deletes };
}

export async function applyExtraction(
  adapter: PersistentMemoryAdapter,
  userId: string,
  ext: MemoryExtraction
): Promise<void> {
  for (const key of ext.deletes) {
    try {
      await adapter.delete(userId, key);
    } catch {
      // best-effort: one failure must not block the rest
    }
  }
  for (const { key, value } of ext.upserts) {
    try {
      await adapter.set(userId, key, value);
    } catch {
      // best-effort
    }
  }
}

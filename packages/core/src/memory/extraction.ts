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

const SYSTEM_PROMPT = `你是用户记忆抽取器。从一段对话回合中抽取可长期复用的用户事实与稳定偏好（称呼、语言偏好、行业/品牌背景、长期约束）。
不要抽取一次性请求、临时上下文或敏感信息（密码、支付信息）。
你会拿到该用户的现有记忆。请产出：
- upserts：需要新增或值发生变化的记忆，key 用稳定的英文 snake_case（如 preferred_language、brand_name）。
- deletes：被用户更正、推翻或明显过时、应删除的现有 key。
没有任何可记内容时，两个数组都为空。
严格只输出 JSON，不要解释、不要 markdown：{"upserts":[{"key":"","value":""}],"deletes":[""]}`;

export function buildExtractionMessages(
  turn: MemoryTurn,
  existing: MemoryEntry[]
): Message[] {
  const existingText = existing.length
    ? existing.map((e) => `- ${e.key}: ${e.value}`).join("\n")
    : "（无）";
  const userContent =
    `[现有记忆]\n${existingText}\n\n` +
    `[本回合对话]\n用户: ${turn.userMessage}\n助手: ${turn.assistantText}`;
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

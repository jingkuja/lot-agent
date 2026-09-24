import { z } from "zod";
import type { MemoryEntry } from "../memory/store.js";
const aliases: Record<string, string> = { name: "display_name", user_name: "display_name", language: "preferred_language", user_language: "preferred_language" };
export function canonicalFactKey(key: string) { const normalized = key.normalize("NFKC").trim().toLowerCase(); return aliases[normalized] ?? normalized; }
export const factInput = z.object({
  key: z.string().trim().min(1).max(100).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).transform(canonicalFactKey),
  value: z.union([z.string().max(5000), z.number().finite(), z.boolean(), z.array(z.string().max(500)).max(50)]),
  type: z.enum(["text", "number", "boolean", "list"]).default("text"),
  category: z.string().trim().min(1).max(100).default("个人信息"),
  active: z.boolean().default(true), shareWithApi: z.boolean().default(false),
  validFrom: z.string().datetime({ offset: true }).nullable().default(null),
  validUntil: z.string().datetime({ offset: true }).nullable().default(null),
  version: z.number().int().nonnegative().default(0),
  collectionIds: z.array(z.string().uuid()).max(10).refine((ids) => new Set(ids).size === ids.length).default([]),
}).strict().superRefine((value, ctx) => {
  const actual = Array.isArray(value.value) ? "list" : typeof value.value === "string" ? "text" : typeof value.value;
  if (value.type !== actual || (typeof value.value === "string" && !value.value.trim())) ctx.addIssue({ code: "custom", message: "值与字段类型不匹配或为空" });
  if (value.validFrom && value.validUntil && Date.parse(value.validUntil) <= Date.parse(value.validFrom)) ctx.addIssue({ code: "custom", message: "失效时间必须晚于生效时间" });
});
export type FactInput = z.infer<typeof factInput>;
export const factText = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
export function mergeFactMemory(legacy: MemoryEntry[], facts: Array<{ key: string; value: unknown; current: boolean; updatedAt: number }>): MemoryEntry[] {
  const reserved = new Set(facts.map((fact) => canonicalFactKey(fact.key)));
  return [...facts.filter((fact) => fact.current).map((fact) => ({ key: fact.key, value: factText(fact.value), tier: "user" as const, meta: { source: "confirmed_fact" }, createdAt: fact.updatedAt })), ...legacy.filter((entry) => !reserved.has(canonicalFactKey(entry.key)))];
}

export const KnowledgeCandidateResolutionSchema = z.object({ accept: z.boolean(), version: z.number().int().nonnegative() }).strict();

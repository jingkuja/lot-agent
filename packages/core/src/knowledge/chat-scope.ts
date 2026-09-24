import type { KnowledgeSourceType } from "./types.js";
export const KNOWLEDGE_SOURCE_LABELS: Record<KnowledgeSourceType, string> = {
  document: "文档", note: "笔记", bookmark: "书签说明", image: "图片说明", audio: "音频说明", video: "视频说明", profile_fact: "有效个人信息",
};
export const DEFAULT_CHAT_SOURCE_TYPES: KnowledgeSourceType[] = ["document", "note"];
export function parseChatSourceTypes(value: unknown): KnowledgeSourceType[] {
  if (value === undefined) return [...DEFAULT_CHAT_SOURCE_TYPES];
  if (!Array.isArray(value) || !value.length || value.length > 7 || value.some((v) => typeof v !== "string" || !Object.hasOwn(KNOWLEDGE_SOURCE_LABELS, v))) throw new Error("INVALID_KNOWLEDGE_SOURCE_TYPES");
  return [...new Set(value)] as KnowledgeSourceType[];
}

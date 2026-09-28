import { lexicalText } from "./ingestion/profile.js";

// Remove only conversational scaffolding, never domain words or negations.
const scaffolding = new Set("请 请问 帮 帮忙 我 我们 查 查询 找 搜索 一下 的 了 呢 吗 啊 是 在 有 和 与 及 什么 怎么 如何 哪些 哪个 多少 是否 需要 可以 告诉 根据 关于 the a an is are what how please".split(" "));

/** Query-side only: existing immutable embedding profiles and lexical indexes stay valid. */
export function retrievalQuery(input: string) {
  const normalized = input.normalize("NFKC").toLowerCase();
  const identifiers = [...new Set([
    ...(normalized.match(/[a-z0-9]+(?:[-_.][a-z0-9]+)+/g) ?? []),
    ...lexicalText(normalized).split(/\s+/).filter((term) => /^\d+$/.test(term) || /^[a-z0-9]+$/.test(term) && /[a-z]/.test(term) && /\d/.test(term)),
  ])];
  // Identifier fragments are already covered by their intact identifier.
  const required = identifiers.filter((id) => !identifiers.some((other) => other !== id && other.split(/[-_.]/).includes(id)));
  const terms = [...new Set(lexicalText(normalized).split(/\s+/).filter((term) => /[\p{L}\p{N}]/u.test(term) && !scaffolding.has(term)))];
  return {
    terms,
    identifiers: required,
    identifierPatterns: required.map((id) => `(^|[^a-z0-9_.-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_.-]|$)`),
  };
}

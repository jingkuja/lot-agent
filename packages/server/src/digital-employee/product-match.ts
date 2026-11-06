/** Below this a mention found in free text is only a guess. */
const NAMED_SCORE = 80;
const LOOSE_SCORE = 50;
const CONFIDENT_SCORE = 70;
const MAX_MATCHES = 3;
const GENERIC_SUFFIX = /(解决方案|服务包|产品|服务|系统|平台|方案|套餐|软件|工具)$/u;
const GENERIC_WORD = /^(解决方案|服务包|产品|服务|系统|平台|方案|套餐|软件|工具|service|product|system|platform)$/;

export interface NamedProduct { id: string; name: string }

export interface ProductHints {
  /** The current request first, then earlier requests, newest first. */
  texts: string[];
  /** Names already recorded on the work item or the customer. */
  named: string[];
}

export function normalizedProductName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(value: string): string[] {
  const chars = Array.from(value);
  return chars.slice(0, -1).map((char, index) => char + chars[index + 1]);
}

function tokens(name: string): string[] {
  return (name.match(/[a-z0-9]+|\p{Script=Han}+/gu) ?? [])
    .filter((token) => /[a-z0-9]/.test(token) ? token.length >= 3 : Array.from(token).length >= 2)
    .filter((token) => !GENERIC_WORD.test(token));
}

/** How well a mention or a longer text refers to a product name, 0 when it does not. */
export function productMatchScore(mention: string, productName: string): number {
  const text = normalizedProductName(mention);
  const name = normalizedProductName(productName);
  if (!text || !name) return 0;
  if (text === name) return 100;
  if (text.includes(name)) return 90;
  const core = name.replace(GENERIC_SUFFIX, "");
  if (Array.from(core).length >= 2 && text.includes(core)) return NAMED_SCORE;
  if (Array.from(text).length >= 2 && name.includes(text)) return CONFIDENT_SCORE;
  const grams = bigrams(name);
  if (grams.length >= 3 && grams.filter((gram) => text.includes(gram)).length / grams.length >= 0.6) return 60;
  return tokens(name).some((token) => text.includes(token)) ? LOOSE_SCORE : 0;
}

function scored<T extends NamedProduct>(mention: string, catalog: readonly T[]) {
  return catalog.map((product) => ({ product, score: productMatchScore(mention, product.name) }));
}

/** Every product tied for the best score, so a caller can tell one match from several. */
export function resolveProductMention<T extends NamedProduct>(mention: string, catalog: readonly T[]): { matches: T[]; score: number } {
  const rows = scored(mention, catalog);
  const score = Math.max(0, ...rows.map((row) => row.score));
  if (score < LOOSE_SCORE) return { matches: [], score: 0 };
  return { matches: rows.filter((row) => row.score === score).map((row) => row.product), score };
}

/**
 * For drafts: the same name written differently, or part of one. A mention that adds to a name
 * ("中转站增强版") may be a different product, so it stays a question.
 */
export function confidentProductMatch<T extends NamedProduct>(mention: string, catalog: readonly T[]): T | null {
  const text = normalizedProductName(mention);
  const same = catalog.filter((product) => {
    const name = normalizedProductName(product.name);
    return text === name || text === name.replace(GENERIC_SUFFIX, "");
  });
  if (same.length) return same.length === 1 ? same[0] : null;
  const { matches, score } = resolveProductMention(mention, catalog);
  return matches.length === 1 && score === CONFIDENT_SCORE ? matches[0] : null;
}

export function rankProductCandidates<T extends { name: string }>(requestedName: string, products: T[]): T[] {
  return products
    .map((product, index) => ({ product, index, score: productMatchScore(requestedName, product.name) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ product }) => product);
}

/**
 * Which products a talk track is about. What the user just wrote wins over what the record says,
 * because people ask about a different product than the one on file. This only chooses what the
 * model reads, so a guess is allowed as long as it is marked uncertain.
 */
export function resolveTalkTrackProducts<T extends NamedProduct>(hints: ProductHints, catalog: readonly T[]): { products: T[]; uncertain: boolean } {
  for (const text of hints.texts) {
    const named = scored(text, catalog).filter((row) => row.score >= NAMED_SCORE).sort((a, b) => b.score - a.score);
    if (named.length) return { products: named.slice(0, MAX_MATCHES).map((row) => row.product), uncertain: false };
  }
  for (const name of hints.named) {
    const { matches, score } = resolveProductMention(name, catalog);
    if (matches.length) return { products: matches.slice(0, MAX_MATCHES), uncertain: matches.length > 1 || score < CONFIDENT_SCORE };
  }
  for (const text of hints.texts) {
    const { matches } = resolveProductMention(text, catalog);
    if (matches.length) return { products: matches.slice(0, MAX_MATCHES), uncertain: true };
  }
  return { products: !hints.named.length && catalog.length === 1 ? [catalog[0]] : [], uncertain: false };
}

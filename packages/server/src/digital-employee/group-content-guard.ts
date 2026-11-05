import { InputError } from "./errors.js";

/** Business-owned text the account has confirmed: a hotline here is not customer data. */
export interface GroupContentPolicy {
  identityTerms: string[];
  approvedFacts: string;
}

export interface CustomerIdentityRow {
  display_name: string;
  aliases: string[] | null;
}

export interface AssetReviewFlag {
  type: "customer_name" | "contact_replaced";
  term?: string;
}

/** Titles and roles customers are often filed under; matching them would reject ordinary copy. */
const GENERIC_ALIASES = new Set([
  "老师", "校长", "老板", "老总", "经理", "总监", "主任", "医生", "律师", "同学", "朋友", "客户", "先生", "女士", "小姐", "宝妈", "家长",
]);

const CONTACT_PATTERNS = [
  /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?!\d)/g,
  /(?<!\d)(?:0\d{2,3}[- ]?\d{7,8}|400[- ]?\d{3}[- ]?\d{4})(?!\d)/g,
  /(?<![\d+])\+\d{1,3}[- ]?\d{6,14}(?!\d)/g,
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  /(?:微信号?|wechat|weixin|vx|wx)\s*(?:[:：]\s*[a-z][-_a-z0-9]{5,19}|\s[a-z][-_a-z]*\d[-_a-z0-9]*)/gi,
  /qq(?:号)?[:：\s]*\d{5,12}(?!\d)/gi,
];

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function isAscii(term: string): boolean {
  return /^[\x20-\x7e]+$/.test(term);
}

function asciiPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`);
}

/** Single characters and anything inside a product name are too likely to be ordinary text. */
export function buildIdentityTerms(customers: CustomerIdentityRow[], productNames: string[]): string[] {
  const products = productNames.map(normalize);
  const terms = new Set<string>();
  for (const customer of customers) {
    for (const value of [customer.display_name, ...(customer.aliases ?? [])]) {
      const term = normalize(value ?? "").trim();
      if ([...term].length < 2 || GENERIC_ALIASES.has(term)) continue;
      if (products.some((name) => name.includes(term))) continue;
      terms.add(term);
    }
  }
  return [...terms];
}

export function findContactDetails(text: string, approvedFacts = ""): string[] {
  const value = text.normalize("NFKC");
  const approved = approvedFacts.normalize("NFKC");
  return CONTACT_PATTERNS.flatMap((pattern) => value.match(pattern) ?? [])
    .filter((match) => !approved.includes(match));
}

export function findCustomerNames(text: string, terms: string[]): string[] {
  const value = normalize(text);
  return terms.filter((term) => isAscii(term) ? asciiPattern(term).test(value) : value.includes(term));
}

/** Rejects before any model sees the text. Contact values are never echoed back, since
 * this message reaches the chat model; a name is only what the caller just supplied. */
export function assertGroupContentInput(policy: GroupContentPolicy, fields: Record<string, string | undefined>): void {
  for (const [label, text] of Object.entries(fields)) {
    if (!text) continue;
    if (findContactDetails(text, policy.approvedFacts).length) {
      throw new InputError(`${label}包含联系方式。群体内容不能出现个人联系方式，请去掉后重试`);
    }
    const [name] = findCustomerNames(text, policy.identityTerms);
    if (name) {
      throw new InputError(`${label}包含本账号客户的姓名或别名「${name}」。群体内容不能指向具体客户，请改用这类客户的共同需求描述`);
    }
  }
}

export function containsContactDetails(policy: GroupContentPolicy, text: string): boolean {
  return findContactDetails(text, policy.approvedFacts).length > 0;
}

export function customerNameFlags(policy: GroupContentPolicy, text: string): AssetReviewFlag[] {
  return findCustomerNames(text, policy.identityTerms).map((term) => ({ type: "customer_name", term }));
}

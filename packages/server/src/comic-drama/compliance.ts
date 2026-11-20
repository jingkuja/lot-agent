import {
  complianceContexts, isEducationalRiskTerm, MARKETING_RISK_TABLE, PLATFORM_REVIEW_RULES,
} from "../marketing-video/compliance.js";
import { ComicLibraryError } from "./library-db.js";

export type ComicComplianceCategory = "violence" | "sexual" | "minors" | "political" | "likeness";

export type ComicComplianceRule = {
  id: string;
  category: ComicComplianceCategory;
  platformRuleId: typeof PLATFORM_REVIEW_RULES[number]["id"] | "comic-political";
  terms: readonly string[];
  triggers?: readonly string[];
  patterns?: readonly RegExp[];
};

export type ComicComplianceIssue = {
  ruleId: string;
  category: ComicComplianceCategory;
  field: string;
  excerpt: string;
};

const sharedSexualBlacklist = MARKETING_RISK_TABLE.blacklist.filter(term => ["色情", "嫖娼", "裸贷"].includes(term));

/**
 * Local rule table for comic-drama script, storyboard and dialogue pre-generation screening (spec §8.2 & §9).
 * Covers extreme violence/self-harm, explicit sexual content, harm to minors, real political figures/incitement,
 * and unauthorized real-person likeness / deepfake impersonation.
 */
export const COMIC_DRAMA_RISK_RULES: readonly ComicComplianceRule[] = [
  {
    id: "comic-violence-extreme",
    category: "violence",
    platformRuleId: "platform-violence-danger",
    terms: [
      "血腥虐杀", "肢解", "分尸", "碎尸", "斩首", "自杀教程", "自残教程", "教唆自杀", "制造炸弹", "恐怖袭击", "暴恐",
    ],
    patterns: [
      /\b(?:dismemberment|beheading|suicide\s+tutorial|bomb[-\s]making|terrorist\s+attack)\b/i,
      /\b(?:mutilasi\s+sadis|tutorial\s+bunuh\s+diri|serangan\s+teroris)\b/i,
    ],
  },
  {
    id: "comic-sexual-explicit",
    category: "sexual",
    platformRuleId: "platform-sexual",
    terms: [
      ...sharedSexualBlacklist,
      "淫秽", "强奸", "轮奸", "迷奸", "性侵", "裸照", "黄片", "卖淫", "乱伦", "露点", "性交", "色情片",
    ],
    patterns: [
      /\b(?:pornography|explicit\s+sex|sexual\s+assault|nude\s+photo|incest)\b/i,
      /\b(?:pornografi|pemerkosaan|kekerasan\s+seksual)\b/i,
    ],
  },
  {
    id: "comic-minors-direct",
    category: "minors",
    platformRuleId: "platform-minors",
    terms: [
      "儿童色情", "未成年色情", "恋童", "童妓", "虐童", "虐待儿童", "未成年人裸体", "幼女裸体", "诱导未成年",
    ],
    patterns: [
      /\b(?:child\s+porn|csam|pedophile|child\s+abuse|minor\s+sexual)\b/i,
      /\b(?:pornografi\s+anak|eksploitasi\s+seksual\s+anak|kekerasan\s+anak)\b/i,
    ],
  },
  {
    id: "comic-minors-conditional",
    category: "minors",
    platformRuleId: "platform-minors",
    terms: ["未成年", "儿童", "幼童", "小学生", "初中生"],
    triggers: ["裸体", "情色", "色情", "吸毒", "赌博", "自残", "自杀", "性行为", "虐待"],
  },
  {
    id: "comic-political-figures",
    category: "political",
    platformRuleId: "comic-political",
    terms: [
      "国家领导人", "党和国家领导人", "政治人物", "国家主席", "国务院总理", "颠覆政权", "分裂国家", "反党", "法轮功",
    ],
    patterns: [
      /\b(?:impersonate\s+(?:the\s+)?president|overthrow\s+(?:the\s+)?government|political\s+propaganda)\b/i,
    ],
  },
  {
    id: "comic-likeness-direct",
    category: "likeness",
    platformRuleId: "platform-copyright",
    terms: [
      "盗用肖像", "未经授权明星肖像", "AI换脸明星", "假冒明星", "仿冒真人", "明星裸照", "伪造名人发言", "冒充真人",
    ],
    patterns: [
      /\b(?:unauthorized\s+likeness|celebrity\s+deepfake|impersonate\s+real\s+person)\b/i,
      /\b(?:deepfake\s+selebriti|penyalahgunaan\s+foto\s+asli)\b/i,
    ],
  },
  {
    id: "comic-likeness-conditional",
    category: "likeness",
    platformRuleId: "platform-copyright",
    terms: ["明星", "艺人", "网红", "真人肖像", "名人肖像", "真实人物"],
    triggers: ["盗用", "未授权", "未经授权", "换脸", "冒充", "假冒", "伪造"],
  },
];

export function checkComicDramaCompliance(entries: ReadonlyArray<{ field: string; text: string }>): {
  ok: boolean;
  issues: ComicComplianceIssue[];
} {
  const issues: ComicComplianceIssue[] = [];
  for (const entry of entries) {
    if (!entry.text.trim()) continue;
    for (const context of complianceContexts(entry.text)) {
      for (const rule of COMIC_DRAMA_RISK_RULES) {
        const directMatch = rule.terms.some(term => {
          if (!context.includes(term)) return false;
          if (rule.triggers?.length) {
            return rule.triggers.some(trigger => context.includes(trigger)) && !isEducationalRiskTerm(context, term);
          }
          return !isEducationalRiskTerm(context, term, true);
        });
        const patternMatch = rule.patterns?.some(pattern => pattern.test(context)) ?? false;
        if (directMatch || patternMatch) {
          issues.push({ ruleId: rule.id, category: rule.category, field: entry.field, excerpt: context.slice(0, 200) });
        }
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

export function assertComicDramaCompliance(entries: ReadonlyArray<{ field: string; text: string }>) {
  const result = checkComicDramaCompliance(entries);
  if (!result.ok) throw new ComicLibraryError("CONTENT_COMPLIANCE_REJECTED", 400);
}

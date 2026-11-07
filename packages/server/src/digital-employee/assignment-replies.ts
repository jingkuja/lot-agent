import type { AssignmentDecision } from "./assignment-repository.js";
import { FAILURE_CHOICES, type DecisionAnswer, type FailureChoice } from "./assignment-state.js";

const CHINESE_NUMBERS = "一二三四五六七八九";
const SERIAL = new RegExp(`^(?:选项?|选择|答案是?)?第?(\\d{1,2}|[${CHINESE_NUMBERS}])(?:个|项|条|号)?$`, "u");
const SEPARATOR = /[\s,，、;；/和与及]+/u;

const CHOICE_WORDS: Record<FailureChoice, string[]> = {
  retry: ["重试", "再试", "再试一次", "再来一次", "继续", "retry", "tryagain", "continue"],
  skip: ["跳过", "跳过这个", "skip"],
  change: ["换个做法", "换一个做法", "换种做法", "换个方法", "换个思路", "tryadifferentapproach", "change"],
  end: ["结束", "结束任务", "终止", "不做了", "算了", "end", "stop"],
};

/** Case, width and trailing punctuation are not what a person means by a reply. */
function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s。.!！?？~～、,，:：;；"'“”‘’「」()（）]/gu, "");
}

function serial(text: string): number | null {
  const match = text.normalize("NFKC").replace(/\s+/g, "").replace(/[。.!！、,，)）]+$/u, "").match(SERIAL)?.[1];
  if (!match) return null;
  const chinese = CHINESE_NUMBERS.indexOf(match);
  return chinese >= 0 ? chinese + 1 : Number(match);
}

function option(text: string, options: string[]): string | null {
  const position = serial(text);
  if (position !== null) return options[position - 1] ?? null;
  const wanted = normalize(text);
  return wanted ? options.find((item) => normalize(item) === wanted) ?? null : null;
}

function matchQuestion(text: string, decision: Pick<AssignmentDecision, "options" | "multiSelect">): DecisionAnswer | null {
  const whole = option(text, decision.options);
  if (whole) return { text: whole };
  if (!decision.multiSelect) return null;
  const picks = text.trim().split(SEPARATOR).filter(Boolean).map((part) => option(part, decision.options));
  // Separated by the mark ask_user documents for multiple answers.
  return picks.length > 1 && picks.every(Boolean) ? { text: [...new Set(picks)].join("、") } : null;
}

function matchFailure(text: string): DecisionAnswer | null {
  const position = serial(text);
  if (position !== null) return FAILURE_CHOICES[position - 1] ? { choice: FAILURE_CHOICES[position - 1] } : null;
  const wanted = normalize(text);
  const choice = FAILURE_CHOICES.find((item) => CHOICE_WORDS[item].includes(wanted));
  return choice ? { choice } : null;
}

/** A reply that can only be an answer to this decision. Anything looser stays with the general assistant. */
export function matchDecisionReply(text: string, decision: Pick<AssignmentDecision, "kind" | "options" | "multiSelect">): DecisionAnswer | null {
  return decision.kind === "question" ? matchQuestion(text, decision) : matchFailure(text);
}

/** A quoted reply is always an answer, so what does not match is the owner's own words. */
export function quotedReply(text: string, decision: Pick<AssignmentDecision, "kind" | "options" | "multiSelect">): DecisionAnswer {
  return matchDecisionReply(text, decision) ?? (decision.kind === "question" ? { text } : { choice: "change", text });
}

export function isContinueReply(text: string): boolean {
  return ["继续", "继续吧", "接着做", "continue"].includes(normalize(text));
}

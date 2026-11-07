import type { FailureChoice, FailureReason } from "./assignment-state.js";

const SUMMARY_CHARS = 500;

const FAILURE_ZH: Record<FailureReason, string> = {
  blocked: "员工判断这件事做不下去",
  model_failed: "模型调用失败",
  empty_response: "模型没有给出结果",
  stalled: "连续几轮没有进展",
  timed_out: "这一轮运行超时",
  unknown_outcome: "有操作的结果没有确认，重试前请先核实",
  interrupted: "服务重启打断了任务",
};

const FAILURE_EN: Record<FailureReason, string> = {
  blocked: "the employee could not go further",
  model_failed: "a model call failed",
  empty_response: "the model returned nothing",
  stalled: "it made no progress for several rounds",
  timed_out: "a run timed out",
  unknown_outcome: "an action's result is unconfirmed, so check it before retrying",
  interrupted: "a service restart interrupted it",
};

const CHOICES_ZH: Record<FailureChoice, string> = { retry: "重试", skip: "跳过", change: "换个做法（写上怎么做）", end: "结束任务" };
const CHOICES_EN: Record<FailureChoice, string> = { retry: "Retry", skip: "Skip", change: "Try another way (say how)", end: "End the task" };

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > SUMMARY_CHARS ? `${trimmed.slice(0, SUMMARY_CHARS)}…` : trimmed;
}

/** Only a link to the owner's own page: results stay in the app. */
export function assignmentLink(id?: string): string {
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (!base) return "";
  return `${base}/digital-employee/assignments${id ? `/${id}` : ""}`;
}

export function finishedNotice(input: {
  name: string; title: string; status: unknown; failureReason?: FailureReason | null; summary?: unknown; link: string; missed?: unknown;
}, english: boolean): string {
  const { name, title, failureReason, link } = input;
  const summary = typeof input.summary === "string" ? clip(input.summary) : "";
  const missed = Array.isArray(input.missed) ? input.missed.filter((item): item is string => typeof item === "string") : [];
  const done = missed.length
    ? (english ? `${name} partly finished "${title}". Not done: ${missed.join(", ")}.` : `${name}做完了「${title}」的一部分，没完成的有：${missed.join("、")}。`)
    : (english ? `${name} finished "${title}".` : `${name}做完了「${title}」。`);
  const lines = input.status === "succeeded"
    ? [done, summary]
    : [
      english
        ? `${name} could not finish "${title}": ${FAILURE_EN[failureReason ?? "model_failed"]}.`
        : `${name}没能完成「${title}」：${FAILURE_ZH[failureReason ?? "model_failed"]}。`,
      summary,
    ];
  return [...lines, link].filter(Boolean).join("\n");
}

export function quotaNotice(input: { name: string; count: number; link: string }, english: boolean): string {
  const { name, count, link } = input;
  const line = english
    ? `${name} paused ${count} task${count === 1 ? "" : "s"}: the balance has run out or the key is unavailable. Progress is kept. Top up, then reply "continue" or choose Continue on the task page.`
    : `${name}暂停了 ${count} 个任务：额度不足或 Key 不可用。进度都保留着，充值后回复「继续」或在任务页点继续，就能接着做。`;
  return [line, link].filter(Boolean).join("\n");
}

export function costLimitNotice(input: { name: string; title: string; link: string }, english: boolean): string {
  const { name, title, link } = input;
  const line = english
    ? `${name} paused "${title}": it reached the cost limit you set. Raise the limit to continue.`
    : `${name}暂停了「${title}」：已到你设的费用上限。调高上限后可以继续。`;
  return [line, link].filter(Boolean).join("\n");
}

function failureLines(input: { title: string; name: string; failureReason?: FailureReason | null; summary?: unknown }, english: boolean): string[] {
  const reason = input.failureReason ?? "model_failed";
  const summary = typeof input.summary === "string" ? clip(input.summary) : "";
  const unverified = reason === "unknown_outcome" && (english
    ? "Open the task page to confirm what happened before retrying."
    : "要先到任务页核实，才能重试或换个做法。");
  const labels = english ? CHOICES_EN : CHOICES_ZH;
  return [
    english ? `${input.name} stopped on "${input.title}": ${FAILURE_EN[reason]}.` : `${input.name}在「${input.title}」上停下了：${FAILURE_ZH[reason]}。`,
    summary,
    ...(unverified ? [unverified] : []),
    ...(Object.keys(labels) as FailureChoice[]).map((choice, index) => `${index + 1}. ${labels[choice]}`),
  ];
}

/** Says which task it is and how to answer, because several can be waiting at once. Model text stays clipped. */
export function decisionNotice(input: {
  name: string; title: string; kind: unknown; question?: unknown; options?: unknown; failureReason?: FailureReason | null; summary?: unknown;
  link: string; reminder: boolean;
}, english: boolean): string {
  const { name, title, link, reminder } = input;
  const options = Array.isArray(input.options) ? input.options.filter((item): item is string => typeof item === "string") : [];
  const body = input.kind === "failure" ? failureLines({ ...input }, english) : [
    english ? `${name} needs your decision on "${title}":` : `${name}在「${title}」上需要你决定：`,
    clip(String(input.question ?? "")),
    ...options.map((option, index) => `${index + 1}. ${option}`),
  ];
  return [
    ...(reminder ? [english ? "This has been waiting for a day." : "这件事已经等了一天。"] : []),
    ...body,
    english ? "Quote this message to reply with a number or in your own words." : "引用这条消息，回复序号或你的想法。",
    link,
  ].filter(Boolean).join("\n");
}

export type ReplyOutcome = "continue" | "skip" | "end" | "answered_already" | "unverified" | "quote_needed";

/** What the bot says back to a routed reply. */
export function replyAck(outcome: ReplyOutcome, link: string, english: boolean): string {
  const zh: Record<ReplyOutcome, string> = {
    continue: "收到，继续执行。",
    skip: "收到，这件事跳过了。",
    end: "收到，任务已结束。",
    answered_already: "这件事已经决定过了，这次回复没有生效。",
    unverified: "还不能继续：有操作的结果没有确认。请先到任务页核实，再回复重试。",
    quote_needed: "现在有几件事在等你决定。请引用要回答的那条通知再回复。",
  };
  const en: Record<ReplyOutcome, string> = {
    continue: "Got it, carrying on.",
    skip: "Got it, skipped.",
    end: "Got it, the task has ended.",
    answered_already: "This was already decided, so this reply changed nothing.",
    unverified: "Not yet: an action's result is unconfirmed. Check it on the task page, then reply again.",
    quote_needed: "Several things are waiting for you. Quote the notice you are answering.",
  };
  return [(english ? en : zh)[outcome], outcome === "unverified" ? link : ""].filter(Boolean).join("\n");
}

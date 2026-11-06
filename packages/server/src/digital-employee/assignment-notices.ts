import type { FailureReason } from "./assignment-state.js";

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
  name: string; title: string; status: unknown; failureReason?: FailureReason | null; summary?: unknown; link: string;
}, english: boolean): string {
  const { name, title, failureReason, link } = input;
  const summary = typeof input.summary === "string" ? clip(input.summary) : "";
  const lines = input.status === "succeeded"
    ? [english ? `${name} finished "${title}".` : `${name}做完了「${title}」。`, summary]
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
    ? `${name} paused ${count} task${count === 1 ? "" : "s"}: the balance has run out or the key is unavailable. Progress is kept. Top up, then choose Continue.`
    : `${name}暂停了 ${count} 个任务：额度不足或 Key 不可用。进度都保留着，充值后点继续就能接着做。`;
  return [line, link].filter(Boolean).join("\n");
}

export function costLimitNotice(input: { name: string; title: string; link: string }, english: boolean): string {
  const { name, title, link } = input;
  const line = english
    ? `${name} paused "${title}": it reached the cost limit you set. Raise the limit to continue.`
    : `${name}暂停了「${title}」：已到你设的费用上限。调高上限后可以继续。`;
  return [line, link].filter(Boolean).join("\n");
}

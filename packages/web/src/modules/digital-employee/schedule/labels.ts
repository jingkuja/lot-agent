import type { ScheduleTemplate, ScheduleTiming } from "../types.js";

type Translate = (text: string, values?: readonly unknown[]) => string;

export const TEMPLATE_LABELS: Record<ScheduleTemplate, string> = {
  follow_up_prep: "跟进准备",
  weekly_review: "经营周报",
};

export const TEMPLATE_HINTS: Record<ScheduleTemplate, string> = {
  follow_up_prep: "看今天要跟进的客户，写好先聊什么。没有要跟进的客户时不运行。",
  weekly_review: "总结过去 7 天的客户工作，给出下周值得做的事。",
};

export const RUN_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  succeeded: "已完成",
  failed: "没有成功",
  cancelled: "已取消",
  skipped: "已跳过",
  missed: "已错过",
};

export const REASON_LABELS: Record<string, string> = {
  overlap: "上一次还没结束",
  daily_limit: "今天已运行 2 次",
  quota: "额度不足",
  nothing_to_do: "今天没有要准备的内容",
  schedule_removed: "这项定时工作已删除",
  enqueue_failed: "没能开始",
  model_failed: "模型没有返回可用结果",
  abandoned: "运行中断",
};

export const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function timingText(timing: ScheduleTiming, t: Translate, locale: string): string {
  if (timing.kind === "once") return t("{0} 运行一次", [new Date(timing.at).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })]);
  if (timing.kind === "daily") return t("每天 {0}", [clock(timing.hour, timing.minute)]);
  return t("每{0} {1}", [t(WEEKDAYS[timing.weekday]!), clock(timing.hour, timing.minute)]);
}

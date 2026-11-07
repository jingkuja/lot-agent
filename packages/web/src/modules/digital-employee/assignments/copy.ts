import type { Assignment, AssignmentFailure, BoardEvent, BoardKind } from "../types.js";

type Stateful = Pick<Assignment, "status" | "pausedReason"> & { subtasks?: Assignment["subtasks"] };

const partlyDone = (item: Stateful) => item.status === "succeeded" && (item.subtasks?.missed ?? 0) > 0;

export function statusLabel(item: Stateful): string {
  if (item.pausedReason) return "已暂停";
  if (partlyDone(item)) return "部分完成";
  return ({
    queued: "排队中", running: "进行中", succeeded: "已完成", failed: "没有完成", cancelled: "已取消",
    waiting_user: "等你决定", waiting_team: "等待中", waiting_children: "等待中", skipped: "已跳过",
  } as Record<string, string>)[item.status] ?? "进行中";
}

export function statusTone(item: Stateful): string {
  if (item.pausedReason || item.status === "waiting_user" || partlyDone(item)) return "paused";
  if (item.status === "succeeded") return "done";
  if (item.status === "failed") return "failed";
  if (item.status === "cancelled" || item.status === "skipped") return "muted";
  return "active";
}

export const BOARD_KIND_LABELS: Record<BoardKind, string> = { summary: "进展", finding: "发现", output: "产出", alert: "提醒", status: "状态" };

export const BOARD_EVENT_LABELS: Record<BoardEvent, string> = {
  added: "新增子任务", succeeded: "完成了", failed: "没有完成", waiting_user: "等你决定", skipped: "已跳过", cancelled: "已取消", followed_up: "你追问",
};

export const MODE_LABELS: Record<Assignment["mode"], string> = { autonomous: "完全自主", responsive: "及时响应" };

export const MODE_HINTS: Record<Assignment["mode"], string> = {
  autonomous: "完全自主：员工自己做决定，不中途问你，写入和生成都会直接做。",
  responsive: "及时响应：遇到要你拿主意的事或做不下去时，员工停下来问你，你回答后接着做。",
};

export const FAILURE_LABELS: Record<AssignmentFailure, string> = {
  blocked: "员工判断这件事做不下去",
  model_failed: "模型调用失败",
  empty_response: "模型没有给出结果",
  stalled: "连续几轮没有进展",
  timed_out: "这一轮运行超时",
  unknown_outcome: "有操作的结果没有确认，重试前请先核实",
  interrupted: "服务重启打断了任务",
};

export const PAUSE_LABELS: Record<NonNullable<Assignment["pausedReason"]>, string> = {
  quota: "额度不足或 Key 不可用，充值后可以继续",
  cost_limit: "已到你设的费用上限，调高后可以继续",
};

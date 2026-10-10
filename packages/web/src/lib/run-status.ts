import type { RunStatus } from "@lot-agent/core";

export const runStatusLabels: Record<RunStatus, string> = {
  completed: "已完成",
  awaiting_input: "等待你的回复",
  failed: "执行失败",
  cancelled: "已停止",
  timed_out: "执行超时，已保留已有结果",
  budget_exhausted: "已达到本轮执行预算",
  unknown_outcome: "操作结果待核实，请先检查结果再重试",
  empty_response: "模型未返回有效回答",
  stalled: "连续执行未获得新信息，已停止",
};

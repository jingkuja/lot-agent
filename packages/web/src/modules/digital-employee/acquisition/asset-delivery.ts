import type { MarketingAsset } from "../types.js";

const GENERATION_STATE: Record<MarketingAsset["generationStatus"], string> = {
  pending: "排队中", running: "正在生成", ready: "已就绪", failed: "生成失败", cancelled: "已取消",
};

/** Chinese source label for `t()`; terminal states must never read as in-progress. */
export function generationStateLabel(status: MarketingAsset["generationStatus"]) {
  return GENERATION_STATE[status] ?? status;
}

export function generationStopped(status: MarketingAsset["generationStatus"]) {
  return status === "failed" || status === "cancelled";
}

/** Feedback counts are increments; reject anything that is not a non-negative integer instead of guessing. */
export function feedbackCount(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) throw new Error("反馈数量必须是非负整数");
  return parsed;
}

export function assetTextFileName(title: string) {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 80);
  return `${base || "营销文案"}.txt`;
}

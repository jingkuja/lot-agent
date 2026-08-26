export const POINTS_PER_YUAN = 100;
export const MIN_RECHARGE_POINTS = 100;
export const RECHARGE_POINTS_STEP = 100;

export function yuanToPoints(yuan: number): number {
  if (!Number.isFinite(yuan)) return 0;
  return Math.max(0, Math.round(yuan * POINTS_PER_YUAN));
}

export function pointsToYuan(points: number): number {
  if (!Number.isFinite(points)) return 0;
  return Math.max(0, points / POINTS_PER_YUAN);
}

export function isValidRechargePoints(points: number): boolean {
  return Number.isSafeInteger(points) &&
    points >= MIN_RECHARGE_POINTS &&
    points % RECHARGE_POINTS_STEP === 0;
}

export function formatPoints(points: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Math.max(0, points));
}

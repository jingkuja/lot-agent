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

export interface RechargeDiscountTier {
  threshold: number;
  discount: number;
}

export function rechargeDiscountTiers(amountDiscount: Record<string, number> = {}): RechargeDiscountTier[] {
  return Object.entries(amountDiscount).flatMap(([rawThreshold, discount]) => {
    const threshold = Number(rawThreshold);
    return Number.isSafeInteger(threshold) && threshold > 0 && Number.isFinite(discount) && discount > 0 && discount <= 1
      ? [{ threshold, discount }]
      : [];
  }).sort((a, b) => a.threshold - b.threshold);
}

export function rechargeDiscountForPoints(points: number, amountDiscount: Record<string, number> = {}): number {
  if (!Number.isFinite(points) || points <= 0) return 1;
  let discount = 1;
  for (const tier of rechargeDiscountTiers(amountDiscount)) {
    if (tier.threshold > points) break;
    discount = tier.discount;
  }
  return discount;
}

export function rechargePayableYuan(points: number, amountDiscount: Record<string, number> = {}): number {
  if (!Number.isFinite(points) || points <= 0) return 0;
  return Math.round(points * rechargeDiscountForPoints(points, amountDiscount)) / POINTS_PER_YUAN;
}

export function isValidRechargePoints(points: number): boolean {
  return Number.isSafeInteger(points) &&
    points >= MIN_RECHARGE_POINTS &&
    points % RECHARGE_POINTS_STEP === 0;
}

export function formatPoints(points: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Math.max(0, points));
}

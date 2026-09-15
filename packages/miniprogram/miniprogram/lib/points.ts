/** 积分口径：与网页端 `web/src/lib/points.ts` 一致，1 元 = 100 积分。 */

export const POINTS_PER_YUAN = 100;

export function yuanToPoints(yuan: number): number {
  if (!Number.isFinite(yuan)) return 0;
  return Math.max(0, Math.round(yuan * POINTS_PER_YUAN));
}

export function formatPoints(points: number): string {
  if (!Number.isFinite(points) || points <= 0) return "0";
  return points.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

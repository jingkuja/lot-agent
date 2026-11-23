import { videoTierEdge } from "@lot-agent/core";

const POINTS_PER_SECOND = {
  seedance25: { 480: 90, 720: 130, 1080: 160, 2160: 220 },
  other: { 480: 80, 720: 120, 1080: 150, 2160: 200 },
};

const RESOLUTION_ALIASES = new Map([
  ["480", 480], ["720", 720], ["1080", 1080], ["2160", 2160],
  ["sd", 480], ["hd", 720], ["fhd", 1080], ["uhd", 2160],
]);

export function estimateVideoTokenPoints(model: string, resolution: unknown, seconds: unknown): number | null {
  if (typeof resolution !== "string" || typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0 || seconds > 86_400) {
    return null;
  }
  const size = resolution.trim().toLowerCase().replace(/\s/g, "").replace(/[×*]/g, "x");
  const edge = RESOLUTION_ALIASES.get(size) ?? videoTierEdge(size);
  if (edge === undefined || !Number.isSafeInteger(edge) || edge <= 0) return null;
  const tier = edge >= 2160 ? 2160 : edge >= 1080 ? 1080 : edge >= 720 ? 720 : 480;
  const isSeedance25 = /seedance[^a-z0-9]*2[._-]?5(?!\d)/i.test(model);
  const rates = isSeedance25 ? POINTS_PER_SECOND.seedance25 : POINTS_PER_SECOND.other;
  return seconds * rates[tier];
}

import { videoTierEdge } from "@lot-agent/core";
import type { ModelEstimateRequest } from "../tokenhub/client.js";

const POINTS_PER_SECOND = { 480: 80, 720: 120, 1080: 150, 2160: 200 };

const RESOLUTION_ALIASES = new Map([
  ["480", 480], ["720", 720], ["1080", 1080], ["2160", 2160],
  ["sd", 480], ["hd", 720], ["fhd", 1080], ["uhd", 2160],
]);

const SEEDANCE_DIMENSIONS = {
  480: { "16:9": [854, 480], "4:3": [752, 560], "1:1": [640, 640], "21:9": [992, 432] },
  720: { "16:9": [1280, 720], "4:3": [1112, 834], "1:1": [960, 960], "21:9": [1470, 630] },
  1080: { "16:9": [1920, 1080], "4:3": [1664, 1248], "1:1": [1440, 1440], "21:9": [2206, 946] },
  2160: { "16:9": [3840, 2160], "4:3": [3326, 2494], "1:1": [2880, 2880], "21:9": [4398, 1886] },
} as const;

export const isSeedanceTokenModel = (model: string) => /seedance[^a-z0-9]*2[._-]?[05](?!\d)/i.test(model);

function videoEstimateInput(usage: ModelEstimateRequest) {
  const { video, request_parameters: parameters } = usage;
  const { resolution, seconds } = video ?? {};
  if (typeof resolution !== "string" || typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0 || seconds > 86_400) {
    return null;
  }
  const size = resolution.trim().toLowerCase().replace(/\s/g, "").replace(/[×*]/g, "x");
  const edge = RESOLUTION_ALIASES.get(size) ?? videoTierEdge(size);
  if (edge === undefined || !Number.isSafeInteger(edge) || edge <= 0) return null;
  const tier: keyof typeof SEEDANCE_DIMENSIONS = edge >= 2160 ? 2160 : edge >= 1080 ? 1080 : edge >= 720 ? 720 : 480;
  const reference = parameters?.reference_video_seconds ?? 0;
  const output = parameters?.output_video_seconds ?? seconds;
  if (typeof reference !== "number" || !Number.isFinite(reference) || reference < 0 || reference > 86_400
    || typeof output !== "number" || !Number.isFinite(output) || output <= 0 || output > seconds) return null;
  return { size, tier, seconds: output + reference };
}

/** Ark documents one video token formula for Seedance 2.x, including synchronized audio. */
export function estimateSeedanceVideoTokens(usage: ModelEstimateRequest): number | null {
  const input = videoEstimateInput(usage);
  if (!input) return null;
  const { size, tier, seconds } = input;
  const ratio = usage.request_parameters?.estimate_ratio ?? usage.request_parameters?.ratio;
  const ratios = SEEDANCE_DIMENSIONS[tier];
  const aspect = ratio === "1:1" || ratio === "21:9" ? ratio : ratio === "4:3" || ratio === "3:4" ? "4:3" : "16:9";
  const explicitSize = /^(\d+)x(\d+)$/.exec(size);
  const [width, height] = explicitSize ? explicitSize.slice(1).map(Number)
    : tier === 480 && aspect === "16:9" && /seedance[^a-z0-9]*2[._-]?0(?!\d)/i.test(usage.model) ? [864, 496] : ratios[aspect];
  const tokens = Math.ceil(seconds * width * height * 24 / 1024);
  return Number.isSafeInteger(tokens) && tokens > 0 && tokens <= 100_000_000 ? tokens : null;
}

export function estimateVideoTokenPoints(usage: ModelEstimateRequest): number | null {
  const input = videoEstimateInput(usage);
  if (!input) return null;
  return input.seconds * POINTS_PER_SECOND[input.tier];
}

import { describe, expect, it, vi } from "vitest";
import { UsageMeter } from "./meter.js";
import { makePricingLookup } from "./pricing-lookup.js";
import type { DB } from "../db/database.js";

describe("video usage and quota", () => {
  it.each([
    ["daily", "DAILY_LIMIT_EXCEEDED"],
    ["monthly", "MONTHLY_LIMIT_EXCEEDED"],
  ])("identifies the %s spending limit", async (period, code) => {
    const db = {
      ensureUserBalance: vi.fn(async () => ({ [`${period}_limit`]: 5 })),
      getDailySpend: vi.fn(async () => 4),
      getMonthlySpend: vi.fn(async () => 4),
    };
    const meter = new UsageMeter(db as unknown as DB, () => undefined);
    expect(await meter.checkQuota("u1", 2)).toMatchObject({ ok: false, code });
    expect(await meter.checkQuota("u1", 1)).toEqual({ ok: true });
  });

  it.each([
    ["doubao-seedance-2-5", 0.8],
    ["minimax-video-h3", 0.5],
  ])("records %s as video seconds with exact or default video pricing", async (modelId, price) => {
    const writeUsageLog = vi.fn();
    const meter = new UsageMeter({ writeUsageLog } as unknown as DB, makePricingLookup(() => undefined, {
      providerMap: {}, defaultProvider: {},
      pricing: { "doubao-seedance-2-5": { inputPrice: 0, outputPrice: 0, unitPrice: 0.8 } },
      defaultPricing: { video: { inputPrice: 0, outputPrice: 0, unitPrice: 0.5 } },
    }, "video"));
    expect(await meter.record({ userId: "u1", taskId: "t1", modelId, usage: { inputCount: 0, outputCount: 10 } })).toBe(10 * price);
    expect(writeUsageLog).toHaveBeenCalledWith(expect.objectContaining({ modelId, modelType: "video", outputCount: 10, totalCost: 10 * price }));
  });
});

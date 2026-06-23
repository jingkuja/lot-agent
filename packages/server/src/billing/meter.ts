import { calcCost, type UsageCounts } from "@lot-agent/core";
import type { ModelConfig } from "@lot-agent/core";
import type { DB } from "../db/database.js";

export class UsageMeter {
  constructor(
    private readonly db: DB,
    private readonly getModelConfig: (id: string) => ModelConfig | undefined
  ) {}

  /** Record a model call. Returns the cost in 元 (0 if model unknown). */
  async record(p: {
    userId: string;
    taskId?: string | null;
    modelId: string;
    usage: UsageCounts;
  }): Promise<number> {
    const cfg = this.getModelConfig(p.modelId);
    if (!cfg) {
      console.warn(`[UsageMeter] unknown model "${p.modelId}", skipping billing`);
      return 0;
    }
    const cost = calcCost(cfg, p.usage);
    await this.db.writeUsageLog({
      userId: p.userId,
      taskId: p.taskId ?? null,
      modelId: cfg.id,
      modelType: cfg.type,
      inputCount: p.usage.inputCount,
      outputCount: p.usage.outputCount,
      totalCost: cost,
    });
    return cost;
  }

  /** Returns { ok } or { ok: false, reason } if estimatedCost would exceed a limit. */
  async checkQuota(
    userId: string,
    estimatedCost: number
  ): Promise<{ ok: boolean; reason?: string }> {
    const bal = await this.db.ensureUserBalance(userId);
    if (bal.daily_limit != null) {
      const spent = await this.db.getDailySpend(userId);
      if (spent + estimatedCost > bal.daily_limit) {
        return {
          ok: false,
          reason: `daily limit ${bal.daily_limit} would be exceeded (spent ${spent.toFixed(4)}, est +${estimatedCost.toFixed(4)})`,
        };
      }
    }
    if (bal.monthly_limit != null) {
      const spent = await this.db.getMonthlySpend(userId);
      if (spent + estimatedCost > bal.monthly_limit) {
        return {
          ok: false,
          reason: `monthly limit ${bal.monthly_limit} would be exceeded`,
        };
      }
    }
    return { ok: true };
  }
}

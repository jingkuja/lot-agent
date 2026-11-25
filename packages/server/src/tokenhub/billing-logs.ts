export type TokenhubChargeLog = {
  user_id: number; token_id: number; model_name: string; request_id?: string; quota: number; other: Record<string, unknown>;
};
export type TokenhubBillingUnits = { quotaPerUnit: number; currency: "CNY" | "USD"; exchangeRate: number };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function logDetails(value: unknown): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? record(JSON.parse(value)) : null;
    if (parsed) return parsed;
  } catch { /* Keep malformed billing metadata ineligible for matching. */ }
  return { invalid: true };
}

export class TokenhubBillingLogs {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async read(path: string, signal: AbortSignal, key?: string): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error("TOKENHUB_BILLING_UNAVAILABLE");
    const envelope = record(await response.json());
    if (envelope?.success !== true) throw new Error("TOKENHUB_BILLING_UNAVAILABLE");
    return envelope.data;
  }

  async units(signal: AbortSignal): Promise<TokenhubBillingUnits> {
    const value = record(await this.read("/api/status", signal));
    const quotaPerUnit = value?.quota_per_unit;
    if (!positive(quotaPerUnit) || typeof value?.quota_display_type !== "string") throw new Error("TOKENHUB_BILLING_UNAVAILABLE");
    if (value.quota_display_type !== "CNY") return { quotaPerUnit, currency: "USD", exchangeRate: 1 };
    if (!positive(value.usd_exchange_rate)) throw new Error("TOKENHUB_BILLING_UNAVAILABLE");
    return { quotaPerUnit, currency: "CNY", exchangeRate: value.usd_exchange_rate };
  }

  async charges(key: string, signal: AbortSignal): Promise<TokenhubChargeLog[]> {
    const rows = await this.read("/api/log/token", signal, key);
    if (!Array.isArray(rows)) throw new Error("TOKENHUB_BILLING_UNAVAILABLE");
    return rows.flatMap((row: unknown) => {
      const entry = record(row);
      if (entry?.type !== 2) return [];
      const { user_id, token_id, model_name, request_id, quota, other } = entry;
      if (!positive(user_id) || !Number.isSafeInteger(user_id) || !positive(token_id) || !Number.isSafeInteger(token_id)
        || typeof model_name !== "string" || typeof quota !== "number" || !Number.isSafeInteger(quota) || quota < 0) return [];
      return [{ user_id, token_id, model_name, quota, ...(typeof request_id === "string" ? { request_id } : {}), other: logDetails(other) }];
    });
  }
}

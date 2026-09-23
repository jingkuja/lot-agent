import "../src/load-env.js";
import { DB } from "../src/db/database.js";
const db = new DB({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
try {
  const { rows } = await db.pool.query(`SELECT u.id, max(s.last_seen_at) AS last_seen FROM users u LEFT JOIN sessions s ON s.user_id=u.id GROUP BY u.id ORDER BY max(s.last_seen_at) DESC NULLS LAST`);
  const owner = rows.find((row) => row.last_seen)?.id;
  if (!owner) throw new Error("No recent authenticated user");
  const key = await db.getUserApiKey(owner, process.env.NEW_API_MANAGED_KEYS !== "0");
  if (!key) throw new Error("No runtime credential for the selected user");
  const base = (process.env.OPENAI_BASE_URL ?? "").replace(/\/$/, "");
  const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  const payload = await response.json() as { data?: Array<{ id: string; [key: string]: unknown }> };
  const selected = payload.data?.filter((model) => /embed|rerank/i.test(model.id));
  if (process.argv.includes("--embed")) {
    const status = await (await fetch(new URL("/api/status", base), { signal: AbortSignal.timeout(15000) })).json() as { data: { quota_per_unit: number; usd_exchange_rate: number } };
    if (!(status.data.quota_per_unit > 0) || !(status.data.usd_exchange_rate > 0)) throw new Error("Cannot determine gateway quota conversion");
    const result = await fetch(`${base}/embeddings`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "qwen3.7-text-embedding", input: ["产品支持离线查看已下载资料。", "如何离线查看资料？"], encoding_format: "float" }), signal: AbortSignal.timeout(60000) });
    const requestId = result.headers.get("x-oneapi-request-id") ?? result.headers.get("x-request-id");
    const body = await result.json() as { model?: string; data?: Array<{ index: number; embedding: number[] }>; usage?: { total_tokens: number } };
    if (!result.ok) { console.log(JSON.stringify({ embeddingStatus: result.status, requestId })); process.exitCode = 1; }
    else {
      let charged: { quota: number; request_id: string } | undefined;
      for (let n = 0; n < 5 && !charged; n++) {
        const logs = await (await fetch(new URL("/api/log/token", base), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })).json() as { data?: Array<{ quota: number; request_id: string }> };
        charged = logs.data?.find((log) => log.request_id === requestId);
        if (!charged) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!charged || !Number.isSafeInteger(body.usage?.total_tokens)) throw new Error("Probe usage needs reconciliation; request ID: " + requestId);
      const cost = charged.quota / status.data.quota_per_unit * status.data.usd_exchange_rate;
      await db.writeUsageLog({ userId: owner, modelId: "qwen3.7-text-embedding", modelType: "embedding", inputCount: body.usage!.total_tokens, outputCount: 0, totalCost: cost });
      console.log(JSON.stringify({ embeddingStatus: result.status, requestId, model: body.model, dimensions: body.data?.map((row) => row.embedding.length), indexes: body.data?.map((row) => row.index), usage: body.usage, quota: charged.quota, costCny: cost, finite: body.data?.every((row) => row.embedding.every(Number.isFinite)) }));
    }
  } else console.log(JSON.stringify({ ownerId: owner, baseUrl: base, status: response.status, models: selected?.map((model) => ({ id: model.id, object: model.object })) }));

} finally { await db.close(); }

export const KNOWLEDGE_JOB_TYPE = "knowledge.ingest";
export function knowledgeQueueConfig(env: NodeJS.ProcessEnv = process.env) {
  const queueName = env.KNOWLEDGE_QUEUE ?? "lot-knowledge";
  const concurrency = Number(env.KNOWLEDGE_CONCURRENCY ?? 2);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(queueName) || queueName === "lot-tasks") throw new Error("Knowledge requires a distinct queue name");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Knowledge concurrency must be 1–8");
  const poolMax = Number(env.KNOWLEDGE_PG_POOL_MAX ?? 4);
  if (!Number.isInteger(poolMax) || poolMax < 2 || poolMax > 32) throw new Error("Knowledge DB pool must be 2–32");
  return { queueName, concurrency, poolMax };
}

export function knowledgeRedisOptions(raw = process.env.REDIS_URL ?? "redis://localhost:6379") {
  const url = new URL(raw);
  if (!["redis:", "rediss:"].includes(url.protocol)) throw new Error("Invalid Redis protocol");
  const db = Number(url.pathname.slice(1) || 0);
  if (!Number.isInteger(db) || db < 0) throw new Error("Invalid Redis database");
  return { host: url.hostname, port: Number(url.port || 6379), db,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

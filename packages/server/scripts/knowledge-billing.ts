import "../src/load-env.js";
import { KnowledgeUuidSchema } from "@lot-agent/core";
import { DB } from "../src/db/database.js";
import { indexProfile } from "../src/knowledge/ingestion/profile.js";
import { reconcileEmbeddingReceipts } from "../src/knowledge/ingestion/receipts.js";
const [operation, ownerArg, routeArg] = process.argv.slice(2);
const owner = KnowledgeUuidSchema.parse(ownerArg);
const db = new DB({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
try {
  if (operation === "reconcile") {
    const route = indexProfile(routeArg).providerRoute;
    // Supply a retired key through environment, never through argv or output.
    const key = process.env.KNOWLEDGE_RECEIPT_KEY ?? await db.getUserApiKey(owner, process.env.NEW_API_MANAGED_KEYS !== "0");
    if (!key) throw new Error("EMBEDDING_CREDENTIAL_REQUIRED");
    console.log({ reconciled: await reconcileEmbeddingReceipts(db, owner, route, key, undefined, process.argv.includes("--legacy")) });
  } else if (operation !== "status") throw new Error("Usage: knowledge:billing status OWNER | reconcile OWNER ORIGINAL_ROUTE [--legacy]");
  const result = await db.pool.query(`SELECT provider_route,model_id,count(*)::int AS pending_count,sum(input_tokens)::int AS input_tokens,
    min(created_at) AS oldest_pending,credential_fingerprint IS NULL AS legacy FROM rag_embedding_charges WHERE owner_id=$1 AND total_cost IS NULL
    GROUP BY provider_route,model_id,credential_fingerprint IS NULL`, [owner]);
  console.log(JSON.stringify({ pending: result.rows }));
} finally { await db.close(); }

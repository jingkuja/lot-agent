import "../src/load-env.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { cpus, totalmem, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { DB } from "../src/db/database.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { KnowledgeJobs } from "../src/knowledge/ingestion/jobs.js";
import { KnowledgeRetriever } from "../src/knowledge/retrieval.js";
import { indexArtifact } from "../src/knowledge/ingestion/indexer.js";
import { indexProfile, lexicalText } from "../src/knowledge/ingestion/profile.js";
import { createUserEmbedder } from "../src/knowledge/ingestion/runtime.js";
import { textBlocks } from "../src/knowledge/ingestion/text.js";
import { PARSER_VERSION } from "../src/knowledge/ingestion/version.js";
import type { KnowledgeRetrievalMode } from "@lot-agent/core";
if (!process.argv.includes("--live") || !process.argv.includes("--latest-user")) throw new Error("Requires --live --latest-user (real metered calls)");
if (!["localhost", "127.0.0.1", "::1"].includes(process.env.PG_HOST ?? "localhost")) throw new Error("Local evaluation only");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const raw = await readFile(resolve(root, "tests/eval/knowledge-v1.json"), "utf8");
const dataset = JSON.parse(raw) as { version: string; provenance: string; documents: string[][]; unanswerable: string[] };
const output = resolve(root, "tests/eval/results"); await mkdir(output, { recursive: true });
const db = new DB({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
const owner = randomUUID(); const other = randomUUID(); const queue = `rag-eval-${owner}`;
const repo = new KnowledgeRepository(db.pool, queue); const jobs = new KnowledgeJobs(db.pool);
const profile = indexProfile(process.env.OPENAI_BASE_URL!); const started = new Date().toISOString();
const samples: Record<string, unknown>[] = []; const metrics: Record<string, unknown>[] = [];
const percentiles = (values: number[]) => { const a = [...values].sort((a,b) => a-b); return { n: a.length, p50: a[Math.ceil(a.length * .5)-1] ?? 0, p95: a[Math.ceil(a.length * .95)-1] ?? 0 }; };
let seeded = false;
try {
  const billingOwner = (await db.pool.query("SELECT user_id FROM sessions ORDER BY last_seen_at DESC LIMIT 1")).rows[0]?.user_id;
  if (!billingOwner || !await db.getUserApiKey(billingOwner, process.env.NEW_API_MANAGED_KEYS !== "0")) throw new Error("No authorized credential");
  await db.pool.query("INSERT INTO users(id,name) VALUES($1,'S4 eval fixture'),($2,'S4 eval other')", [owner, other]); seeded = true;
  const collection = (await repo.createCollection(owner, { name: "S4 frozen corpus", description: "synthetic" }, randomUUID())).id;
  const foreign = (await repo.createCollection(other, { name: "S4 foreign corpus", description: "synthetic" }, randomUUID())).id;
  const realEmbed = createUserEmbedder(db, profile, billingOwner, undefined, { application: "S4 frozen evaluation v1" });
  const cachePath = resolve(output, `vectors-${createHash("sha256").update(raw + profile.id).digest("hex").slice(0,16)}.json`);
  const persisted: Record<string, { vector: number[]; tokens: number; ms: number }> = JSON.parse(await readFile(cachePath, "utf8").catch(() => "{}"));
  const embed = async (text: string, signal?: AbortSignal, fresh = false) => {
    if (!fresh && persisted[text]) return persisted[text];
    for (let attempt = 0; ; attempt++) {
      const begin = performance.now();
      try { const result = await realEmbed(text, signal); const value = { ...result, ms: performance.now() - begin }; if (!fresh) { persisted[text] = value; await writeFile(cachePath, JSON.stringify(persisted)); } return value; }
      catch (error) { if (attempt >= 2 || !(error instanceof Error) || !["EMBEDDING_PREFLIGHT_FAILED", "EMBEDDING_BILLING_PENDING"].includes(error.message)) throw error; await new Promise((r) => setTimeout(r, 10000)); }
    }
  };
  const items: Array<{ id: string; revisionId: string; content: string }> = [];
  for (const [i, [title, code, body]] of dataset.documents.entries()) {
    const text = `${title} ${code}。${body}`;
    const item = await repo.createItem(i < 40 ? owner : other, { sourceType: "note", title, content: text, description: "", tags: [], collectionIds: [i < 40 ? collection : foreign] }, randomUUID());
    await indexArtifact(jobs, (await jobs.claim(item.taskId!, queue))!, profile, { blocks: textBlocks(text), diagnostics: [], parserVersion: PARSER_VERSION }, embed);
    items.push({ ...item, content: text });
    if (i % 10 === 9) console.log(`Indexed ${i + 1}/50 synthetic documents`);
  }
  const scope = { ownerId: owner, callerKind: "internal" as const, permission: "retrieval:read" as const, collectionIds: [collection] };
  const inputs = dataset.documents.slice(0, 40).flatMap((d, i) => [{ id: `semantic-${i}`, query: d[3], relevant: [items[i].id], category: "answerable" }, { id: `exact-${i}`, query: d[1], relevant: [items[i].id], category: "exact" }]);
  inputs.push(...dataset.unanswerable.map((query, i) => ({ id: `none-${i}`, query, relevant: [] as string[], category: "unanswerable" })));
  const cached = new Map<string, { vector: number[]; tokens: number; ms: number }>();
  for (const [i, input] of inputs.entries()) {
    const start = performance.now(); const value = await embed(input.query); cached.set(input.query, { ...value, ms: value.ms });
    for (const mode of ["keyword", "semantic", "hybrid"] as const) {
      const retriever = new KnowledgeRetriever(db.pool, profile, () => async () => value);
      const begin = performance.now();
      const result = await retriever.retrieve(scope, { query: input.query, collectionIds: [collection], mode, topK: 5, allowDegraded: false, sourceTypes: ["note"], tags: [] });
      const sqlMs = performance.now() - begin;
      const correct = result.results.every((hit) => items.some((item) => item.id === hit.itemId && item.revisionId === hit.revisionId && item.content.includes(hit.content)) && hit.citation?.kind === "text" && hit.citation.startLine === 1);
      samples.push({ id: input.id, category: input.category, mode, relevant: input.relevant, returned: result.results.map((r) => r.itemId), hit: input.relevant.some((id) => result.results.some((r) => r.itemId === id)), citationCorrect: correct, sqlMs, embeddingMs: mode === "keyword" ? 0 : cached.get(input.query)!.ms });
    }
    if (i % 10 === 9) console.log(`Evaluated ${i + 1}/90 query embeddings (shared between semantic/hybrid for comparison)`);
  }
  for (let i = 40; i < 50; i++) {
    const retriever = new KnowledgeRetriever(db.pool, profile, () => async () => { throw new Error("UNAUTHORIZED_MODEL_CALL"); });
    let status = 200;
    try { await retriever.retrieve({ ...scope, collectionIds: [foreign] }, { query: dataset.documents[i][3], collectionIds: [foreign], mode: "hybrid", topK: 5, allowDegraded: false, sourceTypes: ["note"], tags: [] }); } catch (e) { status = (e as { status?: number }).status ?? 500; }
    samples.push({ id: `denied-${i}`, category: "unauthorized", mode: "hybrid", status });
  }
  // Performance is synthetic capacity data, NOT an extension of the quality evaluation set.
  const perfItem = await repo.createItem(owner, { sourceType: "note", title: "capacity fixture", content: "capacity", description: "", tags: [], collectionIds: [collection] }, randomUUID());
  await db.pool.query("UPDATE rag_items SET active_revision_id=$2,pending_revision_id=NULL WHERE id=$1", [perfItem.id, perfItem.revisionId]);
  await db.pool.query("UPDATE rag_item_revisions SET index_status='ready',index_profile_id=$2 WHERE id=$1", [perfItem.revisionId, profile.id]);
  await db.pool.query("INSERT INTO rag_revision_indexes(owner_id,item_id,revision_id,profile_id,chunk_count) VALUES($1,$2,$3,$4,1)", [owner, perfItem.id, perfItem.revisionId, profile.id]);
  const perfRaw: Record<string, unknown>[] = [];
  for (const count of [10000, 100000]) {
    await db.pool.query("DELETE FROM rag_chunks WHERE owner_id=$1 AND item_id=$2", [owner, perfItem.id]);
    await db.pool.query(`INSERT INTO rag_chunks(owner_id,item_id,revision_id,profile_id,ordinal,content,origin,input_tokens,overlap_characters,lexical,embedding)
      SELECT $1,$2,$3,$4,n,'容量测试设备 '||n,'extracted_text',5,0,to_tsvector('simple','容量 测试 设备 '||n),
      (SELECT ('['||string_agg(((sin(n::float8*d)*0.03)::real)::text,',')||']')::public.vector FROM generate_series(1,1024) d)
      FROM generate_series(1,$5::int) n`, [owner, perfItem.id, perfItem.revisionId, profile.id, count]);
    await db.pool.query("ANALYZE rag_chunks");
    for (const concurrency of [1, 5]) for (const mode of ["keyword", "semantic", "hybrid"] as const) {
      const result: { totalMs: number; modelMs: number; dbMs: number; error?: string }[] = [];
      let next = 0; const scenarioStart = performance.now();
      const retriever = new KnowledgeRetriever(db.pool, profile, () => async (query) => cached.get(query)!);
      // Warm one request; 20 measured requests per scenario, exact scan baseline.
      const run = async (query: string) => retriever.retrieve(scope, { query, collectionIds: [collection], mode, topK: 5, allowDegraded: false, sourceTypes: ["note"], tags: [] });
      await run(inputs[0].query);
      await Promise.all(Array.from({ length: concurrency }, async () => {
        for (;;) { const n = next++; if (n >= 20) break;
          if (process.argv.includes("--paced")) { const due = scenarioStart + Math.floor(n / concurrency) * concurrency * 1200; await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now()))); }
          const query = inputs[n].query; const start = performance.now(); let modelMs = 0;
          try {
            // Real provider latency measured separately; its vector used in this very request.
            if (mode !== "keyword") { const m = performance.now(); const v = await embed(query, undefined, true); modelMs = performance.now()-m; cached.set(query, { ...v, ms: modelMs }); }
            const d = performance.now(); await run(query);
            result.push({ totalMs: performance.now()-start, modelMs, dbMs: performance.now()-d });
          } catch (e) { result.push({ totalMs: performance.now()-start, modelMs, dbMs: 0, error: e instanceof Error ? e.message : "failed", stage: (e as { stage?: string }).stage, status: (e as { status?: number }).status }); }
        }
      }));
      perfRaw.push({ count, concurrency, mode, samples: result });
      metrics.push({ count, concurrency, mode, inclusiveMs: percentiles(result.map((r) => r.totalMs)), excludingEmbeddingMs: percentiles(result.map((r) => r.dbMs)), embeddingMs: percentiles(result.map((r) => r.modelMs)), errors: result.filter((r) => r.error).length, rssBytes: process.memoryUsage().rss });
      console.log(`Capacity ${count} / concurrent ${concurrency} / ${mode}: ${result.filter((r) => r.error).length} errors`);
    }
  }
  const versions = (await db.pool.query("SELECT version(),(SELECT extversion FROM pg_extension WHERE extname='vector') AS vector")).rows[0];
  const report = { admission: process.argv.includes("--paced") ? "50/min average, bursts up to concurrency" : "unpaced stress bypassing external 60/min limiter", started, finished: new Date().toISOString(), dataset: dataset.version, sha256: createHash("sha256").update(raw).digest("hex"), provenance: dataset.provenance, model: profile.modelId, dimensions: profile.dimensions, profile, node: process.version, hardware: { platform: platform(), arch: arch(), cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem() }, versions, quality: ["keyword", "semantic", "hybrid"].map((mode) => { const all = samples.filter((s) => s.mode === mode && ["answerable", "exact"].includes(String(s.category))); return { mode, answerable: all.length, recallAt5: all.filter((s) => s.hit).length / all.length, citationCorrectness: all.filter((s) => s.citationCorrect).length / all.length }; }), unauthorizedLeaks: samples.filter((s) => s.category === "unauthorized" && s.status !== 404).length, samples, performance: metrics, performanceRaw: perfRaw };
  await writeFile(resolve(output, (process.argv.includes("--paced") ? "knowledge-v1-paced.json" : "knowledge-v1.json")), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ quality: report.quality, unauthorizedLeaks: report.unauthorizedLeaks, report: process.argv.includes("--paced") ? "tests/eval/results/knowledge-v1-paced.json" : "tests/eval/results/knowledge-v1.json" }));
} finally {
  if (seeded) { await db.pool.query("DELETE FROM tasks WHERE user_id=ANY($1::text[])", [[owner, other]]); await db.pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[owner, other]]); }
  await db.close();
}

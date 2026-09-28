import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "../db/migrations/index.js";
import { KnowledgeRepository } from "./repository.js";
import { KnowledgeJobs } from "./ingestion/jobs.js";
import { indexArtifact } from "./ingestion/indexer.js";
import { indexProfile, lexicalText } from "./ingestion/profile.js";
import { textBlocks } from "./ingestion/text.js";
import { KnowledgeRetriever, fuseRanks } from "./retrieval.js";

// This measures lexical recall only. Constant fixture vectors make no semantic-quality claim.
describe.skipIf(process.env.RAG_INTEGRATION !== "1")("frozen Chinese keyword retrieval regression", () => {
  const documents = (JSON.parse(readFileSync(new URL("../../../../tests/eval/knowledge-v1.json", import.meta.url), "utf8")) as { documents: string[][] }).documents.slice(0, 40);
  const owner = randomUUID(); const queue = `lexical-${owner}`;
  const profile = indexProfile(`https://${owner}.invalid/v1`);
  const cache = process.env.RAG_QUALITY_VECTOR_CACHE
    ? JSON.parse(readFileSync(process.env.RAG_QUALITY_VECTOR_CACHE, "utf8")) as Record<string, { vector: number[]; tokens: number }>
    : undefined;
  const embed = async (text: string) => {
    if (cache) { if (!cache[text]) throw new Error("FROZEN_VECTOR_MISSING"); return cache[text]; }
    return { vector: Array.from({ length: 1024 }, (_, n) => n ? 0 : 1), tokens: 8 };
  };
  let pool: pg.Pool; let collection: string;
  const items: string[] = [];
  beforeAll(async () => {
    pool = new pg.Pool({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
    await runMigrations(pool, migrations);
    await pool.query("INSERT INTO users(id,name) VALUES($1,'keyword quality fixture')", [owner]);
    const repo = new KnowledgeRepository(pool, queue); const jobs = new KnowledgeJobs(pool);
    collection = (await repo.createCollection(owner, { name: "frozen quality", description: "synthetic" }, randomUUID())).id;
    for (const [title, code, body] of documents) {
      const content = `${title} ${code}。${body}`;
      const item = await repo.createItem(owner, { sourceType: "note", title, content, tags: [], description: "", collectionIds: [collection] }, randomUUID());
      await indexArtifact(jobs, (await jobs.claim(item.taskId!, queue))!, profile, { blocks: textBlocks(content), diagnostics: [], parserVersion: "fixture" }, embed);
      items.push(item.id);
    }
  });
  afterAll(async () => {
    try {
      await pool.query("DELETE FROM tasks WHERE user_id=$1", [owner]);
      await pool.query("DELETE FROM users WHERE id=$1", [owner]);
    } finally { await pool.end(); }
  });
  it("improves natural-question recall over strict AND and preserves all exact-code hits", async () => {
    const retriever = new KnowledgeRetriever(pool, profile, () => async () => { throw new Error("Keyword search must not call embedding"); });
    const scope = { ownerId: owner, collectionIds: [collection], callerKind: "internal" as const, permission: "retrieval:read" as const };
    let baseline = 0; let natural = 0; let exact = 0;
    const missed: string[] = [];
    for (const [index, [, code, , question]] of documents.entries()) {
      const old = await pool.query(`SELECT item_id FROM rag_chunks WHERE owner_id=$1 AND lexical @@ plainto_tsquery('simple',$2)
        ORDER BY ts_rank_cd(lexical,plainto_tsquery('simple',$2)) DESC,id LIMIT 5`, [owner, lexicalText(question)]);
      baseline += Number(old.rows.some((row) => row.item_id === items[index]));
      for (const [query, isExact] of [[question, false], [code, true]] as const) {
        const result = await retriever.retrieve(scope, { query, collectionIds: [collection], mode: "keyword", topK: 5, tags: [], sourceTypes: ["note"], allowDegraded: false });
        const hit = result.results.some((row) => row.itemId === items[index]);
        if (isExact) exact += Number(hit); else { natural += Number(hit); if (!hit) missed.push(code); }
      }
    }
    console.log(JSON.stringify({ keywordRecallAt5: { baselineNatural: `${baseline}/40`, optimizedNatural: `${natural}/40`, optimizedExact: `${exact}/40` }, missed }));
    expect(natural).toBeGreaterThan(baseline);
    expect(natural).toBeGreaterThanOrEqual(30);
    expect(exact).toBe(40);
  });
  it.skipIf(!cache)("compares hybrid ranking using already-paid frozen vectors without any model calls", async () => {
    const retriever = new KnowledgeRetriever(pool, profile, () => embed);
    const scope = { ownerId: owner, collectionIds: [collection], callerKind: "internal" as const, permission: "retrieval:read" as const };
    const hits = { baselineTop1: 0, baselineTop5: 0, optimizedTop1: 0, optimizedTop5: 0 };
    for (const [index, [, code, , question]] of documents.entries()) for (const query of [question, code]) {
      const vector = (await embed(query)).vector;
      const [body, semantic] = await Promise.all([
        pool.query(`SELECT id,item_id,ts_rank_cd(lexical,plainto_tsquery('simple',$2)) AS value FROM rag_chunks
          WHERE owner_id=$1 AND lexical @@ plainto_tsquery('simple',$2) ORDER BY value DESC,id LIMIT 30`, [owner, lexicalText(query)]),
        pool.query(`SELECT id,item_id,1-(embedding OPERATOR(public.<=>) $2::public.vector) AS value FROM rag_chunks
          WHERE owner_id=$1 ORDER BY embedding OPERATOR(public.<=>) $2::public.vector,id LIMIT 30`, [owner, JSON.stringify(vector)]),
      ]);
      const itemFor = new Map([...body.rows, ...semantic.rows].map((row) => [row.id, row.item_id]));
      const old = fuseRanks([body.rows, semantic.rows]).slice(0, 5).map((row) => itemFor.get(row.id));
      const current = (await retriever.retrieve(scope, { query, collectionIds: [collection], mode: "hybrid", topK: 5, tags: [], sourceTypes: ["note"], allowDegraded: false })).results.map((row) => row.itemId);
      hits.baselineTop1 += Number(old[0] === items[index]); hits.baselineTop5 += Number(old.includes(items[index]));
      hits.optimizedTop1 += Number(current[0] === items[index]); hits.optimizedTop5 += Number(current.includes(items[index]));
      if (old[0] === items[index] && current[0] !== items[index]) console.log(JSON.stringify({ regression: code, query, returned: current.map((id) => documents[items.indexOf(id)]?.[1]) }));
    }
    console.log(JSON.stringify({ frozenCachedHybrid: hits, total: 80 }));
    expect(hits.optimizedTop5).toBeGreaterThanOrEqual(hits.baselineTop5);
    expect(hits.optimizedTop1).toBeGreaterThanOrEqual(hits.baselineTop1);
  });
});

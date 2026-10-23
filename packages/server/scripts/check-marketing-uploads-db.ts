/** Called only by the disposable-database analysis check. No model calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { SecretBox } from "../src/auth/secret-box.js";
import { PgMarketingProjectStore } from "../src/marketing-video/repository.js";
import { PgAnalysisStore } from "../src/marketing-analysis/repository.js";
import type { AnalysisStorage } from "../src/marketing-analysis/storage.js";
import { collectAnalysisFiles } from "../src/marketing-analysis/cleanup.js";
import { copyAnalysisUpload, ownedAnalysisUpload, storeAnalysisUpload } from "../src/marketing-analysis/uploads.js";
import { analysisConfig } from "../src/marketing-analysis/config.js";

export async function checkMarketingUploads(pool: pg.Pool, storage: AnalysisStorage) {
  const owner = randomUUID(), other = randomUUID();
  await pool.query("INSERT INTO users(id,name) VALUES($1,'local video fixture'),($2,'other local video fixture')", [owner, other]);
  const bytes = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");
  const input = { pool, storage, owner, id: randomUUID(), name: "本地.mp4", mime: "video/mp4", body: [bytes] };
  const copies = await Promise.all([storeAnalysisUpload(input), storeAnalysisUpload(input)]);
  assert.deepEqual(copies[0], copies[1]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketing_analysis_uploads WHERE id=$1", [input.id])).rows[0].n, 1);
  await assert.rejects(ownedAnalysisUpload(pool, other, input.id), /UPLOAD_NOT_FOUND/);
  await assert.rejects(storeAnalysisUpload({ ...input, owner: other }), /REQUEST_CONFLICT/);
  const projects = new PgMarketingProjectStore(pool);
  const analyses = new PgAnalysisStore(pool, new SecretBox("00".repeat(32)));
  const config = analysisConfig({ MARKETING_ANALYSIS_ENABLED: "1", YTDLP_VERSION: "2026.07.04", SECRET_MASTER_KEY: "fixture" });
  const project = await projects.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ copyMode: "rewrite", referenceUpload: copies[0] }));
  const request = { uploadId: input.id, clientRequestId: randomUUID(), target: { projectId: project.id, projectVersion: project.version, locale: "zh" as const } };
  await assert.rejects(analyses.create(other, request, config), /UPLOAD_NOT_FOUND/);
  const [first, duplicate] = await Promise.all([analyses.create(owner, request, config), analyses.create(owner, request, config)]);
  assert.equal(first.id, duplicate.id); assert.equal(first.snapshot.source.platform, "local");
  assert.equal(first.snapshot.source.uploadId, input.id);
  assert.equal((await projects.get(owner, project.id))?.referenceAnalysis?.id, first.id);
  const directory = await storage.directory(owner, first.id);
  const uploadDirectory = await storage.uploadDirectory(owner, input.id);
  const source = await copyAnalysisUpload({ pool, storage, owner, source: first.snapshot.source, directory });
  assert.deepEqual(await readFile(join(directory, source.mediaKey!)), bytes);
  // A refresh recovers the same immutable source and associated analysis.
  assert.equal((await new PgAnalysisStore(pool, new SecretBox("00".repeat(32))).create(owner, request, config)).id, first.id);
  await pool.query("UPDATE marketing_analysis_uploads SET created_at=now()-interval '8 days' WHERE id=$1", [input.id]);
  await collectAnalysisFiles(analyses, storage);
  assert.equal((await ownedAnalysisUpload(pool, owner, input.id)).expired_at, null, "active analyses retain their source upload");
  await analyses.cancel(owner, first.id);
  let current = (await projects.get(owner, project.id))!;
  current = await projects.save(owner, current.id, current.version, { ...current.draft, referenceUpload: undefined });
  assert.equal(current.referenceAnalysis, undefined, "removing a local reference clears the previous analysis association");
  await collectAnalysisFiles(analyses, storage);
  await assert.rejects(ownedAnalysisUpload(pool, owner, input.id), /UPLOAD_EXPIRED/);
  await assert.rejects(stat(uploadDirectory), /ENOENT/);
  await assert.rejects(analyses.create(owner, { uploadId: input.id, clientRequestId: randomUUID() }, config), /UPLOAD_EXPIRED/);
  // Copied task bytes are governed by the same source-retention path as links.
  await pool.query("UPDATE marketing_reference_analyses SET created_at=now()-interval '8 days',snapshot=jsonb_set(snapshot,'{source,mediaKey}',$2::jsonb),scratch_cleaned_at=NULL WHERE id=$1", [first.id, JSON.stringify(source.mediaKey)]);
  await collectAnalysisFiles(analyses, storage);
  await assert.rejects(stat(join(directory, source.mediaKey!)), /ENOENT/);
  console.log("PASS: private local uploads, owner isolation, duplicate upload/analysis replay, durable draft sources, association cleanup and seven-day retention");
}

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ANALYSIS_VERSION, type AnalysisLease, type AnalysisSnapshot } from "@lot-agent/core/marketing-analysis";
import type { DB } from "../db/database.js";
import type { TokenhubClient } from "../tokenhub/client.js";
import type { AnalysisConfig } from "./config.js";
import type { PgAnalysisStore } from "./repository.js";
import type { AnalysisStorage } from "./storage.js";
import { AnalysisError } from "./errors.js";
import { AnalysisModels, ANALYSIS_MODELS, userResponsesProvider } from "./models.js";
import { PgAnalysisLedger } from "./ledger.js";
import { downloadAnalysisSource } from "./download.js";
import { extractAnalysisFrames } from "./frames.js";
import { analysisMediaRuntime, type AnalysisMediaRuntime } from "./media-runtime.js";
import { readAnalysisFile } from "./private-files.js";
import { analyzeSelectedFrames } from "./pipeline.js";

export async function analysisUserKey(db: Pick<DB, "getUserApiKey">, hub: Pick<TokenhubClient, "listModels">, owner: string) {
  const key = await db.getUserApiKey(owner, true);
  if (!key) throw new AnalysisError("MODEL_AUTH_REQUIRED", 503);
  const available = await hub.listModels(key);
  if (!Object.values(ANALYSIS_MODELS).every(id => available.llm.includes(id))) throw new AnalysisError("ANALYSIS_MODEL_NOT_ALLOWED", 503);
  return key;
}
export async function runAnalysis(lease: AnalysisLease, signal: AbortSignal, deps: {
  store: PgAnalysisStore; storage: AnalysisStorage; db: DB; hub: TokenhubClient;
  config: AnalysisConfig; baseUrl: string; bridgePath: string; mediaRuntime?: AnalysisMediaRuntime;
}) {
  const mediaRuntime = deps.mediaRuntime ?? analysisMediaRuntime({});
  let row = await deps.store.row(lease.ownerId, lease.id);
  if (row.pipeline_version !== ANALYSIS_VERSION) throw new AnalysisError("ANALYSIS_VERSION_UNSUPPORTED", 409);
  if ((await deps.store.pool.query(`SELECT 1 FROM marketing_analysis_steps WHERE analysis_id=$1 AND user_id=$2
    AND (receipt IS NULL OR receipt->>'outcome'='request_unknown' OR receipt->'usage' IS NULL) LIMIT 1`, [lease.id, lease.ownerId])).rowCount) throw new AnalysisError("REQUEST_UNKNOWN", 409);
  let snapshot = row.snapshot as AnalysisSnapshot;
  const directory = await deps.storage.directory(lease.ownerId, lease.id);
  const checkpoint = (value: AnalysisSnapshot, stage: string) => deps.store.checkpoint(lease, value, stage);
  const models = new AnalysisModels({ ledger: new PgAnalysisLedger(deps.store, lease),
    provider: async model => userResponsesProvider(deps.baseUrl, await analysisUserKey(deps.db, deps.hub, lease.ownerId), model),
    readFrame: frame => readAnalysisFile(directory, frame.objectKey, 4 * 1024 * 1024) });
  signal.throwIfAborted();
  // Check access before downloading, and resolve the user's current key again
  // for each model request. Nothing enters the child-process environment.
  await analysisUserKey(deps.db, deps.hub, lease.ownerId);
  if (row.mode === "summary") {
    const evidence = new Set([...snapshot.frameTexts.map(t => t.frameId), ...snapshot.observations.flatMap(o => o.frameIds)]);
    snapshot.summary = await models.summarize({ revision: lease.revision, frames: snapshot.frames.filter(f => evidence.has(f.id)), texts: snapshot.texts,
      observations: snapshot.observations, durationMs: snapshot.source.durationMs!, metadata: { title: snapshot.source.title, author: snapshot.source.author }, limitations: [
        ...(snapshot.coverage?.limitations ?? []),
        ...(snapshot.frameTexts.length < (snapshot.coverage?.ocrFrames ?? 0) ? ["OCR_INCOMPLETE"] : []),
        ...(new Set(snapshot.observations.flatMap(o => o.frameIds)).size < (snapshot.coverage?.visualFrames ?? 0) ? ["VISUAL_INCOMPLETE"] : []),
      ] }, signal);
    snapshot.summaryRevision = lease.revision;
    await checkpoint(snapshot, "summary");
    return;
  }
  if (!snapshot.source.mediaKey && !row.selection) {
    // Only files from an uncommitted local download are discarded. Model
    // checkpoints never depend on that directory before the source is saved.
    for (const name of await readdir(directory)) await rm(join(directory, name), { recursive: true, force: true });
    const session = (await deps.store.pool.query("SELECT encrypted_cookies FROM marketing_analysis_sessions WHERE user_id=$1 AND platform=$2", [lease.ownerId, snapshot.source.platform])).rows[0];
    const result = await downloadAnalysisSource({ directory, shareText: await deps.store.sourceText(lease), bridgePath: deps.bridgePath,
      expectedDownloaderVersion: deps.config.downloaderVersion, signal, cookies: session ? deps.store.secrets.open(session.encrypted_cookies) : undefined }, mediaRuntime.downloadRuntime);
    snapshot = { ...snapshot, source: result.source };
    await checkpoint(snapshot, "downloaded");
  }
  let selection = row.selection as Awaited<ReturnType<typeof extractAnalysisFrames>> | null;
  if (!selection) {
    signal.throwIfAborted();
    selection = await extractAnalysisFrames({ directory, source: snapshot.source, runner: mediaRuntime.decoderRunner(directory), signal });
    snapshot.source.durationMs = selection.durationMs;
    await deps.store.checkpoint(lease, snapshot, "frames", selection);
  }
  await analyzeSelectedFrames({ snapshot, selection, revision: lease.revision, models, checkpoint, signal });
}

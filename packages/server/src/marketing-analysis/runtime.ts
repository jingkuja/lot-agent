import { withAnalysisAudioUrl } from "./audio-url.js";
import { ASR_MODEL, extractAnalysisAudio, transcribeAnalysisAudio } from "./speech.js";
import { createDeadline, withAbort } from "@lot-agent/core";
import { summaryInput } from "./summary-input.js";
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

export async function analysisUserAccess(db: Pick<DB, "getUserApiKey">, hub: Pick<TokenhubClient, "listModels">, owner: string, signal?: AbortSignal) {
  const deadline = createDeadline(15_000, signal);
  try {
    deadline.signal.throwIfAborted();
    const key = await withAbort(db.getUserApiKey(owner, true), deadline.signal);
    if (!key) throw new AnalysisError("MODEL_AUTH_REQUIRED", 503);
    deadline.signal.throwIfAborted();
    const available = await withAbort(hub.listModels(key, deadline.signal), deadline.signal);
    if (!Object.values(ANALYSIS_MODELS).every(id => available.llm.includes(id))) throw new AnalysisError("ANALYSIS_MODEL_NOT_ALLOWED", 503);
    return { key, asrAvailable: [...available.llm, ...(available.asr ?? []), ...(available.audio ?? [])].includes(ASR_MODEL) };
  } finally { deadline.dispose(); }
}
export async function analysisUserKey(...args: Parameters<typeof analysisUserAccess>) {
  return (await analysisUserAccess(...args)).key;
}
export async function runAnalysis(lease: AnalysisLease, signal: AbortSignal, deps: {
  store: PgAnalysisStore; storage: AnalysisStorage; db: DB; hub: TokenhubClient;
  config: AnalysisConfig; baseUrl: string; bridgePath: string; mediaRuntime?: AnalysisMediaRuntime;
}) {
  const mediaRuntime = deps.mediaRuntime ?? analysisMediaRuntime({});
  let row = await deps.store.row(lease.ownerId, lease.id);
  if (row.pipeline_version !== ANALYSIS_VERSION) throw new AnalysisError("ANALYSIS_VERSION_UNSUPPORTED", 409);
  if ((await deps.store.pool.query(`SELECT 1 FROM marketing_analysis_steps WHERE analysis_id=$1 AND user_id=$2
    AND (receipt IS NULL OR receipt->>'outcome'='request_unknown' OR (receipt->'usage' IS NULL AND receipt->>'outcome'<>'rejected')) LIMIT 1`, [lease.id, lease.ownerId])).rowCount) throw new AnalysisError("REQUEST_UNKNOWN", 409);
  let snapshot = row.snapshot as AnalysisSnapshot;
  signal.throwIfAborted();
  if (snapshot.creation && row.creation_context) return;
  const directory = await deps.storage.directory(lease.ownerId, lease.id);
  const checkpoint = (value: AnalysisSnapshot, stage: string) => deps.store.checkpoint(lease, value, stage);
  const ledger = new PgAnalysisLedger(deps.store, lease);
  const models = new AnalysisModels({ ledger,
    provider: async (model, requestSignal) => userResponsesProvider(deps.baseUrl, await analysisUserKey(deps.db, deps.hub, lease.ownerId, requestSignal), model),
    readFrame: frame => readAnalysisFile(directory, frame.objectKey, 4 * 1024 * 1024) });
  const create = async (value: AnalysisSnapshot) => {
    if (!row.creation_context || row.creation_context.applied || value.creation) return;
    signal.throwIfAborted();
    value.creation = await models.createCopy(row.creation_context.draft, row.creation_context.locale, value, lease.revision, signal);
    await checkpoint(value, "copy");
  };
  signal.throwIfAborted();
  // Check access before downloading, and resolve the user's current key again
  // for each model request. Nothing enters the child-process environment.
  const access = await analysisUserAccess(deps.db, deps.hub, lease.ownerId, signal);
  if (snapshot.summary && snapshot.summaryRevision === lease.revision) { await create(snapshot); return; }
  if (row.mode === "summary") {
    if (!snapshot.completedVisualBatches) {
      const completed = await deps.store.pool.query(`SELECT step_id FROM marketing_analysis_steps WHERE analysis_id=$1 AND user_id=$2
        AND step_id LIKE 'visual:%' AND receipt->>'outcome'='completed' AND receipt->'usage' IS NOT NULL`, [lease.id, lease.ownerId]);
      snapshot.completedVisualBatches = [...new Set(completed.rows.map(r => Number(r.step_id.split(":")[1])))];
    }
    snapshot.summary = await models.summarize(summaryInput(snapshot, lease.revision), signal);
    snapshot.summaryRevision = lease.revision;
    await checkpoint(snapshot, "summary");
    await create(snapshot);
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
    selection = await extractAnalysisFrames({ directory, source: snapshot.source, runner: mediaRuntime.decoderRunner(directory), threads: deps.config.decodeThreads, signal });
    snapshot.source.durationMs = selection.durationMs;
    await deps.store.checkpoint(lease, snapshot, "frames", selection);
  }
  // Legacy synthesis inputs are immutable once submitted. Do not add a paid
  // speech step that would invalidate an existing summary/copy receipt hash.
  const synthesisStarted = !snapshot.speech && (await deps.store.pool.query(
    "SELECT 1 FROM marketing_analysis_steps WHERE analysis_id=$1 AND user_id=$2 AND (step_id LIKE 'summary:%' OR step_id LIKE 'copy:%') LIMIT 1",
    [lease.id, lease.ownerId])).rowCount;
  if (!snapshot.speech && !synthesisStarted) {
    if (!access.asrAvailable) snapshot.speech = { status: "skipped", reason: "ASR_MODEL_UNAVAILABLE" };
    else {
      const audio = await extractAnalysisAudio({ directory, source: snapshot.source, runner: mediaRuntime.decoderRunner(directory), signal });
      if (!audio) snapshot.speech = { status: "skipped", reason: "NO_AUDIO_TRACK" };
      else {
        // Recheck the current user's credential and permission just before submitting audio.
        const current = await analysisUserAccess(deps.db, deps.hub, lease.ownerId, signal);
        snapshot.speech = current.asrAvailable
          ? await withAnalysisAudioUrl({ directory, ownerId: lease.ownerId, analysisId: lease.id, audio,
            publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "", masterKey: process.env.SECRET_MASTER_KEY ?? "" },
          (audioUrl, audioHash) => transcribeAnalysisAudio({ audioUrl, audioHash, baseUrl: deps.baseUrl, apiKey: current.key, ledger, signal }))
          : { status: "skipped", reason: "ASR_MODEL_UNAVAILABLE" };
      }
    }
    signal.throwIfAborted();
    await checkpoint(snapshot, "asr");
  }
  snapshot = await analyzeSelectedFrames({ snapshot, selection, revision: lease.revision, models, checkpoint, signal,
    ocrConcurrency: deps.config.ocrConcurrency, visualConcurrency: deps.config.visualConcurrency });
  await create(snapshot);
}

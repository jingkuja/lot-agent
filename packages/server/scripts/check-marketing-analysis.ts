import "../src/load-env.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { calcCost, type ModelConfig } from "@lot-agent/core";
import { mergeScreenText, type FrameEvidence } from "@lot-agent/core/marketing-analysis";
import { AnalysisModels, userResponsesProvider, ANALYSIS_MODELS } from "../src/marketing-analysis/models.js";
import { ProbeCallLedger } from "../src/marketing-analysis/probe-ledger.js";
import { downloadAnalysisSource } from "../src/marketing-analysis/download.js";
import { extractAnalysisFrames } from "../src/marketing-analysis/frames.js";
import { isolatedMediaRunner } from "../src/marketing-analysis/sandbox.js";
import { DB } from "../src/db/database.js";
import { UsageMeter } from "../src/billing/meter.js";
import { loadLlmConfig } from "../src/config.js";
import { TokenhubClient } from "../src/tokenhub/client.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const mode = process.argv[2];
const runId = process.env.MARKETING_ANALYSIS_PROBE_ID ?? "";
const owner = process.env.MARKETING_ANALYSIS_PROBE_USER_ID ?? "";
if (!["models", "download"].includes(mode) || !/^[a-f0-9-]{36}$/.test(runId) || !/^[A-Za-z0-9_-]{1,100}$/.test(owner)) {
  console.error("Usage: MARKETING_ANALYSIS_PROBE_ID=<UUID> MARKETING_ANALYSIS_PROBE_USER_ID=<user id> pnpm check:marketing-analysis:live models|download\nmodels makes up to 5 paid requests using only that user's key; requires explicit pricing JSON (see docs). download requires Linux sandbox, YTDLP_VERSION and MARKETING_ANALYSIS_PROBE_SOURCE_FILE.");
  process.exit(1);
}
const ownerHash = createHash("sha256").update(owner).digest("hex");
const directory = join(root, "data/marketing-analysis-probes", ownerHash, runId);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
const db = new DB(); const connection = await db.pool.connect();
let locked = false;
try {
  if (!await db.getUserById(owner)) throw new Error("PROBE_USER_NOT_FOUND");
  locked = (await connection.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [`analysis-probe:${owner}`])).rows[0].locked;
  if (!locked) throw new Error("PROBE_ALREADY_RUNNING");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (mode === "download") {
    const file = process.env.MARKETING_ANALYSIS_PROBE_SOURCE_FILE;
    if (!file) throw new Error("PROBE_SOURCE_FILE_REQUIRED");
    const shareText = await readFile(resolve(file), "utf8");
    const sourceDir = join(directory, "source");
    // Cookie input is operator-supplied for this explicit user only. Never
    // inspect browser profiles or share a global default cookie jar.
    const cookiePath = process.env.MARKETING_ANALYSIS_PROBE_COOKIE_FILE;
    const result = await downloadAnalysisSource({ shareText, directory: sourceDir, bridgePath: join(root, "deploy/media-analysis-proxy-bridge.py"), expectedDownloaderVersion: process.env.YTDLP_VERSION ?? "", signal: controller.signal,
      cookies: cookiePath ? await readFile(resolve(cookiePath), "utf8") : undefined });
    const frames = await extractAnalysisFrames({ directory: sourceDir, source: result.source, runner: isolatedMediaRunner(sourceDir), signal: controller.signal });
    await writeFile(join(directory, "download-report.json"), JSON.stringify({ ...result, ...frames }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: "downloaded", platform: result.source.platform, bytes: result.bytes, durationMs: frames.durationMs, frames: frames.frames.length }));
  } else {
    const llmConfig = await loadLlmConfig(root);
    const key = await db.getUserApiKey(owner, true);
    if (!key) throw new Error("PROBE_USER_KEY_REQUIRED");
    const hub = new TokenhubClient(process.env.TOKENHUB_BASE_URL ?? "https://tokenhub.todoucloud.com/api/agent-market", undefined, process.env.NEW_API_AGENT_KEY ?? "");
    const allowed = await hub.listModels(key);
    if (!Object.values(ANALYSIS_MODELS).every(model => allowed.llm.includes(model))) throw new Error("PROBE_MODEL_NOT_ALLOWED");
    // Don't invent a Kimi price or report unknown prices as zero.
    const prices = JSON.parse(process.env.MARKETING_ANALYSIS_PROBE_PRICING ?? "{}");
    // Paid calls of this probe per model: two OCR frames, two image batches and one summary.
    const calls = new Map<string, number>();
    for (const [id, count] of [[ANALYSIS_MODELS.ocr, 2], [ANALYSIS_MODELS.visual, 2], [ANALYSIS_MODELS.synthesis, 1]] as const) {
      calls.set(id, (calls.get(id) ?? 0) + count);
    }
    const configs = [...calls.keys()].map((id): ModelConfig => {
      const p = prices[id];
      if (!p || ![p.inputPrice, p.outputPrice].every(n => typeof n === "number" && Number.isFinite(n) && n > 0)) throw new Error("PROBE_PRICING_REQUIRED");
      return { id, type: "llm", billingUnit: "token", provider: "openai", enabled: true, inputPrice: p.inputPrice, outputPrice: p.outputPrice, unitPrice: 0 };
    });
    const meter = new UsageMeter(db, id => configs.find(c => c.id === id));
    const allowance = configs.reduce((sum, config) => {
      const count = calls.get(config.id)!;
      return sum + calcCost(config, { inputCount: 16384 * count, outputCount: 8192 * count });
    }, 0);
    if (!(await meter.checkQuota(owner, allowance)).ok) throw new Error("PROBE_QUOTA_EXCEEDED");
    const ledger = new ProbeCallLedger(join(directory, "receipts"), async (step, modelId, receipt) => {
      if (receipt.usage) await meter.record({ userId: owner, modelId, usage: { inputCount: receipt.usage.promptTokens, outputCount: receipt.usage.completionTokens }, idempotencyKey: `analysis-probe:${runId}:${step}` });
    });
    const exec = promisify(execFile);
    const frames: FrameEvidence[] = [];
    for (let i = 0; i < 2; i++) {
      const objectKey = `probe-${i}.jpg`;
      // All inputs to this unsandboxed fixture generator are fixed constants;
      // it never processes a downloaded or user-provided media file.
      await exec(process.env.MARKETING_FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=${i ? "blue" : "red"}:s=640x360:d=0.1`, "-vf", `drawtext=text='FRAME ${i + 1} PRICE ${i ? 199 : 99}':fontcolor=white:fontsize=42:x=30:y=150`, "-frames:v", "1", "-y", join(directory, objectKey)], { timeout: 10000, signal: controller.signal, env: { PATH: process.env.PATH } });
      frames.push({ id: `f000${i + 1}`, sourceHash: createHash("sha256").update("synthetic-order-probe-v1").digest("hex"), sourcePts: String(i * 1000), timeBase: "1/1000", ptsMs: i * 1000, width: 640, height: 360, objectKey, reasons: [i ? "end" : "start"] });
    }
    const model = new AnalysisModels({ ledger, provider: async id => userResponsesProvider(llmConfig.openai.baseUrl!, key, id), readFrame: frame => readFile(join(directory, frame.objectKey)) });
    const frameTexts = [];
    for (const frame of frames) frameTexts.push(await model.ocr(frame, controller.signal));
    const single = await model.observe(0, [frames[0]], controller.signal);
    const observations = await model.observe(1, frames, controller.signal);
    const texts = mergeScreenText(frames, frameTexts);
    const summary = await model.summarize({ revision: 1, frames, texts, observations, durationMs: 1100, limitations: ["NO_AUDIO_ANALYSIS", "SYNTHETIC_TEST_IMAGES"] }, controller.signal);
    const receipts = await ledger.records();
    const priceChecks = frameTexts.map((text, i) => text.rawText.includes(i ? "199" : "99"));
    const usageComplete = receipts.every(r => r.receipt?.usage);
    await writeFile(join(directory, "model-report.json"), JSON.stringify({ frameTexts, single, observations, summary, priceChecks, usageComplete, orderNeedsHumanReview: true, receipts }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: "probed", priceChecks, usageComplete, orderNeedsHumanReview: true, report: join(directory, "model-report.json") }));
    if (!priceChecks.every(Boolean) || !usageComplete) process.exitCode = 1;
  }
} catch (error) {
  // Do not print raw provider errors, URLs, cookies, credentials or prompt text.
  const message = error instanceof Error ? error.message : "PROBE_FAILED";
  console.error(/^[A-Z][A-Z_]+$/.test(message) ? message : "PROBE_FAILED");
  process.exitCode = 1;
} finally {
  if (locked) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`analysis-probe:${owner}`]);
  connection.release(); await db.pool.end();
}

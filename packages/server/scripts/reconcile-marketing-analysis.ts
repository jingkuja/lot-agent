import "../src/load-env.js";
import { readFile } from "node:fs/promises";
import { DB } from "../src/db/database.js";
import { PgAnalysisStore } from "../src/marketing-analysis/repository.js";
import { reconcileAnalysisStep } from "../src/marketing-analysis/reconcile.js";

// Explicit operator inputs only. Never infer missing/unknown gateway usage.
const [owner, id, step, attempt, file] = process.argv.slice(2);
const note = process.env.MARKETING_ANALYSIS_RECONCILIATION_NOTE;
if (!owner || !/^[a-f0-9-]{36}$/i.test(id ?? "") || !/^(ocr:f\d{4}|visual:\d+|summary:\d+)$/.test(step ?? "") || !/^[1-9]\d*$/.test(attempt ?? "") || !file || !note) {
  console.error("Usage: MARKETING_ANALYSIS_RECONCILIATION_NOTE=<gateway evidence checked> pnpm marketing-analysis:reconcile <owner> <analysis UUID> <step ID> <attempt> <receipt.json>\nReceipt requires outcome, responseId, text and verified usage {promptTokens,completionTokens}. This records billing and allows an explicit user resume; it does not call a model.");
  process.exit(1);
}
const db = new DB();
try {
  const receipt = JSON.parse(await readFile(file, "utf8"));
  await reconcileAnalysisStep(new PgAnalysisStore(db.pool), owner, id, step, Number(attempt), receipt, note);
  console.log("Reconciled; the user may explicitly resume the analysis.");
} catch { console.error("Reconciliation rejected; verify ownership, lease, step, response ID and usage."); process.exitCode = 1; }
finally { await db.close(); }

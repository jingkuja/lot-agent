import type { AnalysisSnapshot } from "@lot-agent/core/marketing-analysis";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import type { PgAnalysisStore } from "./repository.js";
import { AnalysisError } from "./errors.js";

/** Deterministic preview; source evidence never becomes production shots. */
export function referencePreview(snapshot: AnalysisSnapshot, evidenceIds: string[]) {
  const known = new Set([...snapshot.frames.map(f => f.id), ...snapshot.texts.map(t => t.id), ...(snapshot.speech?.status === "completed" ? [snapshot.speech.id] : [])]);
  if (!evidenceIds.length || evidenceIds.length > 150 || new Set(evidenceIds).size !== evidenceIds.length || evidenceIds.some(id => !known.has(id))) throw new AnalysisError("INVALID_EVIDENCE_REFERENCE");
  const selected = new Set(evidenceIds);
  const sections = [
    ...(snapshot.speech?.status === "completed" && selected.has(snapshot.speech.id) ? [`[a0001 ASR] ${snapshot.speech.text}`] : []),
    ...snapshot.texts.filter(t => selected.has(t.id)).map(t => `[${t.id} ${t.firstSeenMs}–${t.lastSeenMs}ms] ${t.text}`),
    ...(snapshot.summary?.summary ?? []).filter(f => f.evidenceIds.every(id => selected.has(id))).map(f => `[${f.evidenceIds.join(", ")}${f.inference ? "; inference" : ""}] ${f.statement}`),
  ];
  const reference = sections.join("\n");
  if (!reference.trim()) throw new AnalysisError("EVIDENCE_REQUIRED");
  if (reference.length > 6000) throw new AnalysisError("REFERENCE_TOO_LONG");
  return reference;
}
export async function applyAnalysis(store: PgAnalysisStore, owner: string, id: string, input: {
  expectedRevision: number; projectId: string; projectVersion: number; evidenceIds: string[];
}, commit: boolean) {
  return store.transaction(async client => {
    const analysis = await store.row(owner, id, client, true);
    if (analysis.revision !== input.expectedRevision || ["running", "queued"].includes(analysis.status)) throw new AnalysisError("REVISION_CONFLICT", 409);
    const project = (await client.query("SELECT * FROM marketing_video_projects WHERE user_id=$1 AND id=$2 FOR UPDATE", [owner, input.projectId])).rows[0];
    if (!project) throw new AnalysisError("PROJECT_NOT_FOUND", 404);
    if (project.version !== input.projectVersion || project.task_id) throw new AnalysisError("PROJECT_CONFLICT", 409);
    const reference = referencePreview(analysis.snapshot, input.evidenceIds);
    if (commit) {
      const draft = MarketingDraftSchema.parse({ ...project.draft, copyMode: "rewrite", reference });
      await client.query(`UPDATE marketing_video_projects SET draft=$3,version=version+1,updated_at=now(),
        reference_analysis_id=$4,reference_revision=$5,reference_evidence_ids=$6 WHERE id=$1 AND user_id=$2`,
      [project.id, owner, JSON.stringify(draft), id, analysis.revision, JSON.stringify(input.evidenceIds)]);
    }
    return { reference, projectId: project.id, projectVersion: project.version + (commit ? 1 : 0), analysisId: id, acceptedRevision: analysis.revision, evidenceIds: input.evidenceIds };
  });
}

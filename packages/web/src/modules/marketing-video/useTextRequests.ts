import { useEffect, useRef, useState } from "react";
import { marketingReviewText, marketingShotMaxSeconds, marketingSourceKind, marketingVoiceover, planMarketingSegments, storyboardScript,
  type MarketingNarrationClip, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import type { ReferenceAnalysis } from "@lot-agent/core/marketing-analysis";
import { ApiClientError, request } from "../../api/client.js";
import { errorMessage, json, normalizeProject, requestProject, type Project } from "./api.js";
import type { ConfirmRequest } from "./ConfirmDialog.js";
import type { SourceKind } from "./CopyStep.js";
import { stableRequestId } from "./draft-editor.js";
import { checkReferenceVideo } from "./materials.js";
import { analysisError } from "./ReferenceAnalysisPanel.js";
import type { DraftSession } from "./session.js";
import { textOperationEffect, type TextOperationState } from "./text-requests.js";
import type { DraftEditor } from "./useDraftEditor.js";

type RequestIdentity = { fingerprint: string; id: string };
type Translate = (source: string, values?: readonly unknown[]) => string;

/** Recorded text requests of the open draft: copy, storyboard, check and titles, and the analysis
 * of a reference video. A request whose result is unknown keeps editing locked until the user
 * discards it; the same request ID replays a saved result instead of paying again. */
export function useTextRequests({ editor, session, profile, ownerId, locale, t, confirm, wait, act, setError, setNotice }: {
  editor: DraftEditor; session: DraftSession; profile: MarketingVideoProfile; ownerId: string; locale: string; t: Translate;
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** Show a long request beside the step buttons; `textRequest` adds the five-minute note. */
  wait(label: string, textRequest?: boolean): void;
  /** Run one user action at a time, showing its error. */
  act(work: () => Promise<void>): Promise<void>;
  setError(message: string): void; setNotice(message: string): void;
}) {
  const [pending, setPending] = useState(false);
  // The latest text request has no clear result: locked until the user discards it, not "processing".
  const [unknown, setUnknown] = useState(false);
  const [retry, setRetry] = useState(false);
  const [reload, setReload] = useState(0);
  /** Structure notes returned with the latest copy. */
  const [analysis, setAnalysis] = useState("");
  const [analysisPending, setAnalysisPending] = useState(false);
  const [uploadSource, setUploadSource] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const textRequest = useRef<RequestIdentity | null>(null);
  // The last text request sent from this page, repeated when the user discards its unknown result.
  const lastText = useRef<{ kind: string; run: () => Promise<void> } | null>(null);
  const shownUnknown = useRef<string | null>(null);
  const analysisRequest = useRef<{ fingerprint: string; body: unknown } | null>(null);
  const uploadRequest = useRef<RequestIdentity | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const { draftRef, projectRef, save, load, update } = editor;
  // A pasted link or share text is analyzed as a video; anything else is rewritten as copy.
  const sourceKind: SourceKind = uploadSource ? "upload" : editor.draft.reference.trim() ? marketingSourceKind(editor.draft.reference) : "video";
  const recordedRequestId = (kind: string, p: Project, ...input: unknown[]) =>
    stableRequestId(textRequest, JSON.stringify([kind, p.id, p.version, locale, ...input]));

  // After a discarded unknown result, repeat the request once the refreshed state unlocks the page.
  useEffect(() => {
    if (!retry || pending) return;
    setRetry(false);
    const work = lastText.current?.run;
    if (work) void act(work);
  }, [retry, pending]);

  /** Text requests also run beside a finished video; name the step that failed and say the video is unaffected. */
  function failedStep(step: string, error: unknown): Error {
    const reason = t(errorMessage(error));
    return new Error(projectRef.current?.status === "succeeded"
      ? t("{0}未完成（已生成的视频不受影响）：{1}", [t(step), reason]) : t("{0}未完成：{1}", [t(step), reason]));
  }
  async function review() {
    lastText.current = { kind: "review", run: review };
    wait("正在检查文案与分镜");
    const p = await save();
    try {
      const result = await requestProject(`/marketing-videos/${p.id}/review`, json("POST", { locale, version: p.version, clientRequestId: recordedRequestId("review", p) }));
      if (session.alive) { editor.setCurrent(result); setNotice(""); }
    } catch (e) { throw failedStep("文案检查", e); }
    finally { if (session.alive) setReload(n => n + 1); }
  }
  async function analyzeReference(open: (id: string) => Promise<void>) {
    const token = session.token();
    const p = await save();
    if (!session.current(token)) return;
    // Recover the linked job before creating another analysis, including
    // after a lost response or a stale completed-state render.
    if (p.referenceAnalysis) {
      const existing = await request<ReferenceAnalysis>(`/marketing-video-analyses/${p.referenceAnalysis.id}`);
      if (!session.current(token)) return;
      if (existing.status !== "ready") { await open(p.id); return; }
    }
    const fingerprint = JSON.stringify([p.id, p.draft, locale]);
    if (analysisRequest.current?.fingerprint !== fingerprint) analysisRequest.current = { fingerprint, body: {
      ...(sourceKind === "upload" ? { uploadId: p.draft.referenceUpload?.id } : { shareText: p.draft.reference.trim() }),
      clientRequestId: crypto.randomUUID(), target: { projectId: p.id, projectVersion: p.version, locale },
    } };
    try {
      await request<ReferenceAnalysis>("/marketing-video-analyses", json("POST", analysisRequest.current.body));
      if (!session.current(token)) return;
      await open(p.id);
    } catch (e) {
      // A lost POST response may still have committed the job. Reading its
      // project association recovers it without issuing another model call.
      if (session.current(token)) await open(p.id).catch(() => {});
      throw new Error(analysisError(e));
    }
  }
  /** Copy and shots from the topic, or from the reference: pasted copy is rewritten, a video is analyzed first. */
  async function writeCopy(open: (id: string) => Promise<void>) {
    if (draftRef.current.copyMode === "rewrite" && sourceKind !== "text") return analyzeReference(open);
    const run = () => writeCopy(open);
    lastText.current = { kind: "copy", run };
    const token = session.token();
    const p = await save();
    if (!session.current(token)) return;
    const clientRequestId = stableRequestId(textRequest, JSON.stringify(["copy", p.id, p.version, p.draft, locale, sourceKind]));
    wait("正在生成文案和分镜");
    try {
      const result = await request<{ project: Project; analysis: string }>("/marketing-videos/copy", json("POST", {
        draft: p.draft, locale, source: { kind: sourceKind === "upload" ? "video" : sourceKind }, projectId: p.id, version: p.version, clientRequestId,
      }));
      if (!session.current(token)) return;
      load(normalizeProject(result.project)); setAnalysis(result.analysis);
    } finally { if (session.current(token)) setReload(n => n + 1); }
  }
  /** Follow the latest recorded request: lock or unlock editing, and show a result saved elsewhere. */
  async function operationState(operation?: TextOperationState) {
    const effect = textOperationEffect(operation, { version: editor.version.current, dirty: editor.dirty,
      reviewShown: projectRef.current?.reviewedScript === marketingReviewText(draftRef.current) });
    setPending(effect.pending);
    setUnknown(effect.unknown);
    // The panel explains an unknown result and offers its actions; a "try again later" error would contradict it.
    if (effect.unknown && shownUnknown.current !== operation!.id) { shownUnknown.current = operation!.id; setError(""); }
    // A released intent keeps its ID on the server; the next creation needs a new one.
    if (effect.newRequestId) textRequest.current = null;
    if (!effect.reload) return;
    const token = session.token();
    const p = await requestProject(`/marketing-videos/${editor.draftId.current}`);
    if (!session.current(token) || editor.saved.current !== JSON.stringify(draftRef.current)) return;
    load(p);
    if (operation!.kind !== "review" && operation!.kind !== "publication") setAnalysis(operation!.result?.analysis ?? "");
  }
  async function completedAnalysis(value: ReferenceAnalysis) {
    if (value.projectId !== editor.draftId.current || editor.saved.current !== JSON.stringify(draftRef.current)) return;
    const token = session.token();
    const p = await requestProject(`/marketing-videos/${value.projectId}`);
    if (!session.current(token) || editor.saved.current !== JSON.stringify(draftRef.current)) return;
    load(p); setAnalysis(value.snapshot.creation?.analysis ?? "");
  }
  /** Titles and tags; `fillMissing` keeps the ones the user wrote. */
  async function publication(fillMissing = false) {
    lastText.current = { kind: "publication", run: () => publication(fillMissing) };
    wait("正在生成标题和标签");
    const p = await save();
    try {
      const body = { locale, fillMissing, version: p.version, clientRequestId: recordedRequestId("publication", p, fillMissing) };
      const result = await requestProject(`/marketing-videos/${p.id}/publication`, json("POST", body));
      if (session.alive) load(result);
    } catch (e) {
      // Filling missing fields before generating has its own skip prompt that names the step.
      throw fillMissing ? e : failedStep("标题和标签生成", e);
    } finally { if (session.alive) setReload(n => n + 1); }
  }
  /** AI shots for the copy, or the board revised by `instruction` (one shot when `index` is given). */
  async function editStoryboard(instruction = "", index?: number) {
    const token = session.token();
    const p = await save();
    if (!session.current(token)) return;
    lastText.current = { kind: "storyboard", run: () => editStoryboard(instruction, index) };
    const clientRequestId = stableRequestId(textRequest, JSON.stringify(["storyboard", p.id, p.version, locale, instruction, index]));
    wait(instruction ? "正在按要求修改分镜" : "正在生成分镜");
    try {
      const result = await requestProject(`/marketing-videos/${p.id}/storyboard`, json("POST", { version: p.version, locale, instruction, index, clientRequestId }));
      if (!session.current(token)) return;
      load(result); setNotice("分镜已保存，请确认后生成视频。");
    } finally { if (session.current(token)) setReload(n => n + 1); }
  }
  /** Split the copy into shots without AI, with neutral directions for the current audio setting. */
  async function manualStoryboard() {
    const current = draftRef.current;
    const shots = planMarketingSegments(current.script, current.durationSec, marketingShotMaxSeconds(current, profile)).map(part => ({
      durationSec: part.durationSec, script: part.script, visual: t("展示产品与使用场景"),
      action: t(current.assets.video ? "人物正面出镜，无声展示产品，不做说话口型" : marketingVoiceover(current) ? "人物出镜自然展示产品，旁白在画外" : "人物正面出镜，自然讲述并展示产品"),
      camera: t("中景平稳拍摄，缓慢推近主体"),
    }));
    update({ ...current, storyboard: shots, script: storyboardScript(shots), storyboardAudio: !current.assets.video });
    await save();
  }
  const aiStoryboard = (instruction: string, index?: number) => void act(async () => {
    // A whole-board edit may reword or re-split every shot, and a take only fits its own text.
    // The takes are read for the saved draft here: the production step may not have loaded them.
    let takes = 0;
    if (index === undefined && marketingVoiceover(draftRef.current) && draftRef.current.narration?.twinItemId && draftRef.current.storyboard.length) {
      const p = await save();
      takes = await request<{ clips: MarketingNarrationClip[] }>(`/marketing-videos/${p.id}/narration`)
        .then(result => result.clips.filter(clip => clip.status === "succeeded").length, () => 0);
    }
    if (takes && !await confirm({ title: "修改全部分镜？", confirm: "继续修改", values: [takes],
      message: "已生成 {0} 个镜头的数字分身配音。AI 修改全部分镜后，口播或镜头有变化的配音会失效，需要重新生成，会产生费用。是否继续？" })) return;
    await editStoryboard(instruction, index);
  });
  // The server plans every new board for the current audio setting.
  const rebuildStoryboard = () => aiStoryboard(t(draftRef.current.assets.video
    ? "已添加动作参考视频，成片不生成口播：请把每个分镜改为无声展示，人物不说话、不做口型，口播内容只作为字幕或画面信息；保持镜数和每镜时长。"
    : "已移除动作参考视频，成片会生成口播：请把每个分镜改为人物自然讲述口播内容并展示产品；保持镜数和每镜时长。"));
  const keepStoryboard = () => update({ ...draftRef.current, storyboardAudio: !draftRef.current.assets.video });

  function chooseReferenceSource(upload: boolean) {
    setUploadSource(upload);
    if (!upload && draftRef.current.referenceUpload) update({ ...draftRef.current, referenceUpload: undefined });
  }
  async function selectReferenceVideo(file: File) {
    const token = session.token();
    await checkReferenceVideo(file);
    if (!session.current(token)) return;
    const clientRequestId = stableRequestId(uploadRequest, JSON.stringify([ownerId, file.name, file.size, file.lastModified]));
    const controller = new AbortController(); uploadController.current = controller; setUploadingReference(true);
    try {
      // The video itself is the body, so the server streams it to disk instead of buffering a form.
      const upload = await request<{ id: string; name: string }>(`/marketing-video-analyses/uploads?clientRequestId=${clientRequestId}`, { method: "POST", body: file,
        signal: controller.signal, headers: { "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name) } });
      if (!session.current(token)) return;
      update({ ...draftRef.current, reference: "", referenceUpload: upload });
      await save();
    } catch (error) {
      if (error instanceof ApiClientError && ["UPLOAD_EXPIRED", "REQUEST_CONFLICT"].includes(error.code ?? "")) uploadRequest.current = null;
      throw new Error(analysisError(error));
    } finally {
      if (uploadController.current === controller) uploadController.current = null;
      if (session.current(token)) setUploadingReference(false);
    }
  }

  /** Opening a draft: lock text actions until its request records are read. */
  function opening() {
    setPending(true); setUnknown(false); setRetry(false); lastText.current = null;
  }
  /** The opened draft's reference source and analysis state. */
  function opened(p: Project) {
    setUploadSource(!!p.draft.referenceUpload);
    setAnalysisPending(!!p.referenceAnalysis && !p.referenceAnalysis.acceptedRevision);
    setAnalysis(""); setReload(n => n + 1);
  }
  /** A draft that failed to open leaves nothing to wait for. */
  const unlock = () => setPending(false);
  /** Leave the draft's requests behind, e.g. before another draft opens. */
  function release() { setPending(false); textRequest.current = null; }
  /** A new or copied draft has no requests yet. */
  function reset(next: { referenceUpload?: unknown }) {
    lastText.current = null; setRetry(false); setUnknown(false); setAnalysisPending(false); analysisRequest.current = null;
    setUploadSource(!!next.referenceUpload); setAnalysis("");
  }
  /** Abort a reference upload when the studio closes. */
  const abortUpload = () => uploadController.current?.abort();

  return {
    pending, unknown, analysis, analysisPending, setAnalysisPending, uploadSource, uploadingReference, sourceKind, reload,
    /** The request this page can repeat after its unknown result is discarded. */
    retry: lastText.current ? { kind: lastText.current.kind, run: () => setRetry(true) } : undefined,
    review, writeCopy, operationState, completedAnalysis, publication, editStoryboard, manualStoryboard, aiStoryboard, rebuildStoryboard, keepStoryboard,
    chooseReferenceSource, selectReferenceVideo, opening, opened, unlock, release, reset, abortUpload,
  };
}
export type TextRequests = ReturnType<typeof useTextRequests>;

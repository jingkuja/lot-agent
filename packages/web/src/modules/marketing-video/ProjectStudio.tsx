import { useEffect, useId, useRef, useState, type MutableRefObject } from "react";
import { DEFAULT_MARKETING_VIDEO_PROFILE, marketingReferenceError, marketingShotMaxSeconds, marketingAssetIds, marketingSourceKind, MarketingDraftSchema, planMarketingSegments, timeMarketingStoryboard, resolveMarketingSegments, storyboardScript, marketingReviewText, marketingStoryboardAudioMismatch, type MarketingDraft, type MarketingProject, type MarketingShot, type MarketingTaskState, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import type { ReferenceAnalysis } from "@lot-agent/core/marketing-analysis";
import { api, ApiClientError, request } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { DigitalTwinPicker } from "../digital-twin/DigitalTwinPanel.js";
import { TextOperationPanel } from "./TextOperationPanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { ReferenceAnalysisPanel, analysisError } from "./ReferenceAnalysisPanel.js";
import { DraftLibrary, useDraftLibrary } from "./DraftLibrary.js";
import { json, normalizeProject, requestProject, type Project } from "./api.js";
import { ResultPanel } from "./ResultPanel.js";
import { CopyStep, type SourceKind } from "./CopyStep.js";
import { MaterialsStep } from "./MaterialsStep.js";
import { ProductionStep } from "./ProductionStep.js";
import { StoryboardAudioNotice, type DraftForm, type MaterialHandlers } from "./StudioFields.js";
import { checkMaterial, checkReferenceVideo, imageCount, isImageSlot, materialFor, type Material, type MaterialSlot } from "./materials.js";
import { useDraftSession, useExclusive, useTaskPolling } from "./session.js";
import { useConfirm } from "./ConfirmDialog.js";
import { WaitStatus } from "./WaitStatus.js";

type Capabilities = { composition: boolean; knowledge: boolean; model?: MarketingVideoProfile };
type RequestIdentity = { fingerprint: string; id: string };
/** The long request the open draft is waiting on. */
type Wait = { label: string; started: number; textRequest: boolean };
const STEPS = ["确定文案", "确定素材", "确认与制作"];
const reviewedText = marketingReviewText;
const unavailableMessage = "当前服务器尚不支持新版营销视频，请更新服务后重试。";
const pollError = "暂时无法查询进度，正在自动重试；无需重复生成。";
const errorMessage = (error: unknown) => error instanceof ApiClientError && error.status === 404 && /^(404\s+)?Not Found$/i.test(error.message)
  ? unavailableMessage : error instanceof Error ? error.message : "操作失败，请重试。";
/** The same ID while the request is unchanged, so a repeat after a lost response replays the
 * recorded result instead of paying for another model call. */
function requestId(ref: MutableRefObject<RequestIdentity | null>, fingerprint: string) {
  if (ref.current?.fingerprint !== fingerprint) ref.current = { fingerprint, id: crypto.randomUUID() };
  return ref.current.id;
}

export function ProjectStudio({ ownerId = "", onDraftChange }: { ownerId?: string; onDraftChange?: (dirty: boolean) => void }) {
  const { t, locale } = useI18n();
  const generationHintId = useId();
  const storyboardPanel = useRef<HTMLDivElement>(null);
  const session = useDraftSession();
  const exclusive = useExclusive(session);
  const [draft, setDraft] = useState<MarketingDraft>(() => MarketingDraftSchema.parse({}));
  const [project, setProject] = useState<Project | null>(null);
  const [materials, setMaterials] = useState<Record<string, Material>>({});
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  // The server picks the clip model; its limits drive validation and hints here.
  const profile = capabilities?.model ?? DEFAULT_MARKETING_VIDEO_PROFILE;
  const [step, setStep] = useState(0);
  const [analysisPending, setAnalysisPending] = useState(false);
  const [textPending, setTextPending] = useState(false);
  const [operationReload, setOperationReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState<Wait | null>(null);
  const [uploadSource, setUploadSource] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [analysis, setAnalysis] = useState("");
  const [twinOpen, setTwinOpen] = useState<"portrait" | "voice" | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const navigationBusy = exclusive.busy || analysisPending;
  const busy = navigationBusy || textPending;
  // Latest values for async work that started on an earlier render.
  const draftRef = useRef(draft);
  const projectRef = useRef<Project | null>(null);
  // Identity of the open draft and the last state the server confirmed.
  const draftId = useRef<string>(crypto.randomUUID());
  const version = useRef(0);
  const saved = useRef(JSON.stringify(draft));
  const flight = useRef<Promise<Project> | null>(null);
  const textRequest = useRef<RequestIdentity | null>(null);
  const analysisRequest = useRef<{ fingerprint: string; body: unknown } | null>(null);
  const uploadRequest = useRef<RequestIdentity | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const previewRefresh = useRef(new Map<string, number>());
  const storageKey = `lot:marketing-video:${ownerId}`;
  const active = project?.status === "pending" || project?.status === "running";
  const frozen = !!project?.taskId;
  const validReview = !!project?.review && project.reviewedScript === reviewedText(draft);
  const dirty = JSON.stringify(draft) !== saved.current;
  const library = useDraftLibrary(session, ready, e => setError(errorMessage(e)));
  const [confirmDialog, confirm] = useConfirm();
  // A pasted link or share text is analyzed as a video; anything else is rewritten as copy.
  const sourceKind: SourceKind = uploadSource ? "upload" : draft.reference.trim() ? marketingSourceKind(draft.reference) : "video";

  function setCurrent(p: Project) {
    if (p.id === draftId.current && p.version < version.current) return;
    projectRef.current = p; setProject(p); library.put(p);
  }
  function remember(id: string | null) {
    try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey); } catch { /* Server drafts remain available. */ }
  }
  function update(next: MarketingDraft) {
    draftRef.current = next; setDraft(next); setError(""); setNotice("");
  }
  /** Show a project the server returned as the saved state of the editor. */
  function load(p: Project) {
    version.current = p.version; saved.current = JSON.stringify(p.draft);
    update(p.draft); setCurrent(p);
  }
  function field<K extends keyof MarketingDraft>(name: K, value: MarketingDraft[K]) {
    const next = { ...draftRef.current, [name]: value };
    if (value !== draftRef.current[name]) {
      if (name === "script") next.storyboard = [];
      if (name === "durationSec" && next.storyboard.length) {
        try { next.storyboard = timeMarketingStoryboard(next.storyboard, next.durationSec, marketingShotMaxSeconds(next, profile)); }
        catch { next.storyboard = []; }
      }
      // A reference video may lower the shot cap; keep the board and let the plan report conflicts.
      if (name === "assets" && !!next.assets.video !== !!draftRef.current.assets.video && next.storyboard.length) {
        // Older boards carry no record; they were planned before this change.
        next.storyboardAudio ??= !draftRef.current.assets.video;
        try { next.storyboard = timeMarketingStoryboard(next.storyboard, next.durationSec, marketingShotMaxSeconds(next, profile)); }
        catch { /* resolveMarketingSegments shows the error */ }
      }
    }
    update(next);
  }
  const form: DraftForm = { draft, busy, frozen, ready, field };

  useEffect(() => {
    if (!frozen && step === 2 && draft.storyboard.length) storyboardPanel.current?.scrollIntoView({ block: "start" });
  }, [draft.storyboard.length, frozen, step]);

  async function open(id: string) {
    const token = session.next();
    setTextPending(true);
    let p: Project;
    // A failed open must not leave the editor locked as if a text request were pending.
    try { p = await requestProject(`/marketing-videos/${id}`); }
    catch (e) { if (session.current(token)) setTextPending(false); throw e; }
    if (!session.current(token)) return;
    draftId.current = id;
    setUploadSource(!!p.draft.referenceUpload);
    load(p); setMaterials(p.assets ?? {});
    setStep(p.referenceAnalysis ? 0 : p.draft.storyboard.length ? 2 : 0);
    setAnalysisPending(!!p.referenceAnalysis && !p.referenceAnalysis.acceptedRevision);
    setAnalysis(""); remember(id); setOperationReload(n => n + 1);
  }
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    setReady(false); setLoadError("");
    void Promise.all([
      request<{ data: Project[]; nextCursor?: string }>("/marketing-videos?limit=20", { signal: controller.signal }),
      request<Capabilities>("/marketing-videos/capabilities", { signal: controller.signal }),
    ]).then(async ([list, caps]) => {
      if (stopped) return;
      library.showFirstPage(list); setCapabilities(caps);
      let id: string | null = null;
      try { id = localStorage.getItem(storageKey); } catch { /* Optional preference. */ }
      // The remembered draft may be older than the first page.
      if (id) {
        try { await open(id); }
        catch (e) {
          if (e instanceof ApiClientError && e.status === 404 && !/^(404\s+)?Not Found$/i.test(e.message)) remember(null);
          else if (!stopped) setError(errorMessage(e));
        }
      }
      if (!stopped) setReady(true);
    }).catch(e => {
      if (!stopped) setLoadError(e instanceof ApiClientError && e.status === 404 ? unavailableMessage : "营销视频服务暂时无法连接，请重试。");
    }).finally(() => clearTimeout(timeout));
    return () => { stopped = true; session.next(); clearTimeout(timeout); controller.abort(); uploadController.current?.abort(); };
  }, [storageKey, loadAttempt]);

  async function save(): Promise<Project> {
    if (flight.current) { await flight.current; return save(); }
    if (saved.current === JSON.stringify(draftRef.current) && projectRef.current) return projectRef.current;
    const token = session.token(); const snapshot = draftRef.current;
    setSaving(true);
    const pending = requestProject(`/marketing-videos/${draftId.current}`, json("PUT", { version: version.current, draft: snapshot }));
    flight.current = pending;
    try {
      const p = await pending;
      if (session.current(token)) { version.current = p.version; saved.current = JSON.stringify(snapshot); setCurrent(p); remember(p.id); }
      return p;
    } finally {
      if (flight.current === pending) flight.current = null;
      if (session.current(token)) setSaving(false);
    }
  }
  useEffect(() => {
    if (!ready || busy || !dirty) return;
    const timer = setTimeout(() => { void save().catch(e => { if (session.alive) setError(errorMessage(e)); }); }, 900);
    return () => clearTimeout(timer);
  }, [draft, ready, busy]);
  useEffect(() => { onDraftChange?.(dirty || saving || busy); return () => onDraftChange?.(false); }, [dirty, saving, busy, onDraftChange]);

  useTaskPolling(project?.id, active, (state: MarketingTaskState) => {
    const p = projectRef.current;
    if (!p || p.id !== state.id) return;
    setCurrent({ ...p, taskId: state.taskId, status: state.status, progress: state.progress, stage: state.stage, error: state.error,
      errorCode: state.errorCode, output: state.output, unknownSegments: state.unknownSegments });
  }, failed => setError(old => failed ? pollError : old === pollError ? "" : old));

  async function act(work: () => Promise<void>, navigation = false) {
    if (exclusive.locked || analysisPending || (!navigation && textPending) || !ready) return;
    await exclusive.run(async () => {
      setError("");
      try { await work(); } catch (e) { if (session.alive) setError(errorMessage(e)); }
      finally { if (session.alive) setWorking(null); }
    });
  }
  // Review and title/tag requests are recorded like copy: the same ID replays a
  // saved result after a lost response instead of calling the model again.
  const wait = (label: string, textRequest = true) => setWorking({ label, started: Date.now(), textRequest });
  const recordedRequestId = (kind: string, p: Project, ...input: unknown[]) => requestId(textRequest, JSON.stringify([kind, p.id, p.version, locale, ...input]));
  async function review() {
    wait("正在检查文案与分镜");
    const p = await save();
    try {
      const result = await requestProject(`/marketing-videos/${p.id}/review`, json("POST", { locale, version: p.version, clientRequestId: recordedRequestId("review", p) }));
      if (session.alive) { setCurrent(result); setNotice(""); }
    } finally { if (session.alive) setOperationReload(n => n + 1); }
  }
  async function applyReviewEdit(next: MarketingDraft) {
    await act(async () => {
      update(next);
      await review();
    });
  }
  async function analyzeReference() {
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
  async function writeCopy() {
    if (draftRef.current.copyMode === "rewrite" && sourceKind !== "text") return analyzeReference();
    const token = session.token();
    const p = await save();
    if (!session.current(token)) return;
    const clientRequestId = requestId(textRequest, JSON.stringify(["copy", p.id, p.version, p.draft, locale, sourceKind]));
    wait("正在生成文案和分镜");
    try {
      const result = await request<{ project: Project; analysis: string }>("/marketing-videos/copy", json("POST", {
        draft: p.draft, locale, source: { kind: sourceKind === "upload" ? "video" : sourceKind }, projectId: p.id, version: p.version, clientRequestId,
      }));
      if (!session.current(token)) return;
      load(normalizeProject(result.project)); setAnalysis(result.analysis);
    } finally { if (session.current(token)) setOperationReload(n => n + 1); }
  }
  async function textOperationState(operation?: { id: string; kind?: string; status: string; appliedVersion?: number; result?: { analysis?: string } }) {
    setTextPending(!!operation && ["running", "unknown", "needs_apply"].includes(operation.status));
    // A released intent keeps its ID on the server; the next creation needs a new one.
    if (operation?.status === "failed" || operation?.status === "released") textRequest.current = null;
    // A review keeps the version; reload when a recovered review is not shown yet.
    const unseenReview = operation?.kind === "review" && operation.appliedVersion === version.current && projectRef.current?.reviewedScript !== reviewedText(draftRef.current);
    if (operation?.status !== "succeeded" || !operation.appliedVersion || (operation.appliedVersion <= version.current && !unseenReview) || dirty) return;
    const token = session.token();
    const p = await requestProject(`/marketing-videos/${draftId.current}`);
    if (!session.current(token) || saved.current !== JSON.stringify(draftRef.current)) return;
    load(p);
    if (operation.kind !== "review" && operation.kind !== "publication") setAnalysis(operation.result?.analysis ?? "");
  }
  async function completedAnalysis(value: ReferenceAnalysis) {
    if (value.projectId !== draftId.current || saved.current !== JSON.stringify(draftRef.current)) return;
    const token = session.token();
    const p = await requestProject(`/marketing-videos/${value.projectId}`);
    if (!session.current(token) || saved.current !== JSON.stringify(draftRef.current)) return;
    load(p); setAnalysis(value.snapshot.creation?.analysis ?? "");
  }
  async function publication(fillMissing = false) {
    wait("正在生成标题和标签");
    const p = await save();
    try {
      const result = await requestProject(`/marketing-videos/${p.id}/publication`, json("POST", { locale, fillMissing, version: p.version, clientRequestId: recordedRequestId("publication", p, fillMissing) }));
      if (session.alive) load(result);
    } finally { if (session.alive) setOperationReload(n => n + 1); }
  }
  async function generate(retry = false) {
    // Retries resume a frozen job whose recorded model rules the server checks.
    const referenceError = retry ? "" : marketingReferenceError(draftRef.current, profile);
    if (referenceError) { setStep(1); throw new Error(referenceError); }
    if (!retry) resolveMarketingSegments(draftRef.current, profile);
    if (!retry && marketingStoryboardAudioMismatch(draftRef.current) && !await confirm({ title: "分镜与参考视频设置不一致",
      message: draftRef.current.assets.video ? "已添加参考视频，成片不生成口播，但当前分镜按有声口播编写。建议先重新生成分镜。仍要按当前分镜生成吗？" : "已移除参考视频，成片会生成口播，但当前分镜按无声展示编写。建议先重新生成分镜。仍要按当前分镜生成吗？",
      confirm: "仍然生成" })) return;
    if (!retry && (!draftRef.current.publishTitle.trim() || !draftRef.current.tags.trim())) {
      // Titles and tags are publishing metadata: they can be written after the
      // video, so a failed fill must not block production.
      try { await publication(true); }
      catch (e) {
        if (!session.alive || !await confirm({ title: "跳过标题和标签？", message: "标题和标签补全失败：{0}\n可以跳过，成片后再生成或手动填写。是否跳过并继续生成视频？", values: [t(errorMessage(e))], confirm: "跳过并继续生成" })) throw e;
      }
    }
    let p = await save();
    if (!retry && (!p.review || p.reviewedScript !== reviewedText(p.draft))) { await review(); p = projectRef.current!; }
    if (p.review?.verdict === "reject") throw new Error("文案检查发现需要修改的内容，请按「文案与分镜检查」中的提示修改后再生成。");
    wait("正在提交生成任务", false);
    const result = await requestProject(`/marketing-videos/${p.id}/generate`, json("POST", { version: p.version, retry }));
    if (session.alive) setCurrent(result);
  }
  async function editStoryboard(instruction = "", index?: number) {
    const token = session.token();
    const p = await save();
    if (!session.current(token)) return;
    const clientRequestId = requestId(textRequest, JSON.stringify(["storyboard", p.id, p.version, locale, instruction, index]));
    wait(instruction ? "正在按要求修改分镜" : "正在生成分镜");
    try {
      const result = await requestProject(`/marketing-videos/${p.id}/storyboard`, json("POST", { version: p.version, locale, instruction, index, clientRequestId }));
      if (!session.current(token)) return;
      load(result); setNotice("分镜已保存，请确认后生成视频。");
    } finally { if (session.current(token)) setOperationReload(n => n + 1); }
  }
  async function manualStoryboard() {
    const current = draftRef.current;
    const storyboard = planMarketingSegments(current.script, current.durationSec, marketingShotMaxSeconds(current, profile)).map(part => ({
      durationSec: part.durationSec, script: part.script, visual: current.background || t("展示产品与使用场景"),
      action: t(current.assets.video ? "人物正面出镜，无声展示产品，不做说话口型" : "人物正面出镜，自然讲述并展示产品"), camera: t("中景平稳拍摄，缓慢推近主体"),
    }));
    update({ ...current, storyboard, script: storyboardScript(storyboard), storyboardAudio: !current.assets.video });
    await save();
  }
  const changeStoryboard = (storyboard: MarketingShot[]) => update({ ...draftRef.current, storyboard, script: storyboardScript(storyboard) });
  const aiStoryboard = (instruction: string, index?: number) => void act(() => editStoryboard(instruction, index));
  // The server plans every new board for the current audio setting.
  const rebuildStoryboard = () => aiStoryboard(t(draftRef.current.assets.video
    ? "已添加参考视频，成片不生成口播：请把每个分镜改为无声展示，人物不说话、不做口型，口播内容只作为字幕或画面信息；保持镜数和每镜时长。"
    : "已移除参考视频，成片会生成口播：请把每个分镜改为人物自然讲述口播内容并展示产品；保持镜数和每镜时长。"));
  const keepStoryboard = () => update({ ...draftRef.current, storyboardAudio: !draftRef.current.assets.video });

  function chooseReferenceSource(upload: boolean) {
    setUploadSource(upload);
    if (!upload && draftRef.current.referenceUpload) update({ ...draftRef.current, referenceUpload: undefined });
  }
  async function selectReferenceVideo(file: File) {
    const token = session.token();
    await checkReferenceVideo(file);
    if (!session.current(token)) return;
    const clientRequestId = requestId(uploadRequest, JSON.stringify([ownerId, file.name, file.size, file.lastModified]));
    const controller = new AbortController(); uploadController.current = controller; setUploadingReference(true);
    const body = new FormData(); body.append("file", file); body.append("clientRequestId", clientRequestId);
    try {
      const upload = await request<{ id: string; name: string }>("/marketing-video-analyses/uploads", { method: "POST", body, signal: controller.signal });
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
  async function selectMaterial(file: File, slot: MaterialSlot) {
    const token = session.token();
    await checkMaterial(file, slot, draftRef.current, profile);
    const value = await api.uploadFile(file, undefined, "marketing-video");
    if (!session.current(token)) return;
    const multiple = isImageSlot(slot);
    setMaterials(old => ({ ...old, [multiple ? value.assetId : slot]: { id: value.assetId, url: value.url, name: file.name, mime: value.mime } }));
    field("assets", { ...draftRef.current.assets, [slot]: multiple ? [...marketingAssetIds(draftRef.current.assets[slot]), value.assetId] : value.assetId });
  }
  async function refreshMaterial(id: string) {
    // A suspended tab can outlive a capability. Re-authorize the read without
    // saving a draft or retrying a paid operation. Bound broken-media retries.
    if (Date.now() - (previewRefresh.current.get(id) ?? 0) < 60_000) return;
    previewRefresh.current.set(id, Date.now());
    const token = session.token();
    try {
      const fresh = await api.getAsset(id);
      if (!session.current(token)) return;
      setMaterials(old => Object.fromEntries(Object.entries(old).map(([key, value]) => [key, value.id === id ? { ...value, url: fresh.url } : value])));
    } catch (error) { if (session.current(token)) setError(errorMessage(error)); }
  }
  const materialHandlers: MaterialHandlers = {
    materials,
    onFiles: (slot, files) => void act(async () => {
      if (slot === "video" && files.length > 1) throw new Error("参考视频最多 1 个，请先移除已有视频。");
      if (isImageSlot(slot) && imageCount(slot, draftRef.current) + files.length > 3) throw new Error("人物或场景区域各最多 3 张。");
      for (const file of files) await selectMaterial(file, slot);
    }),
    onRemove: (slot, id) => {
      const next = { ...draftRef.current.assets };
      const remaining = marketingAssetIds(next[slot]).filter(value => value !== id);
      if (isImageSlot(slot) && remaining.length) next[slot] = remaining;
      else delete next[slot];
      field("assets", next);
    },
    onRefresh: id => void refreshMaterial(id),
  };

  async function newDraft(copy = false, step = 0) {
    setTextPending(false); textRequest.current = null;
    if (dirty) await save();
    resetDraft(copy, step);
  }
  function resetDraft(copy = false, step = 0) {
    session.next(); draftId.current = crypto.randomUUID(); version.current = 0; projectRef.current = null;
    setProject(null); setAnalysisPending(false); analysisRequest.current = null;
    const next = copy ? { ...draftRef.current } : MarketingDraftSchema.parse({});
    saved.current = copy ? "" : JSON.stringify(next);
    setUploadSource(!!next.referenceUpload);
    update(next); if (!copy) setMaterials({});
    setStep(step); setAnalysis(""); remember(null);
  }
  async function deleteDraft(p: MarketingProject) {
    if (!await confirm({ title: "删除视频草稿", message: "确定删除视频草稿“{0}”吗？删除后无法恢复。\n视频中使用的素材和已生成的视频仍保留在「个人素材」中，如需永久删除，请前往「个人素材」删除。",
      values: [p.draft.publishTitle || p.draft.topic || t("未命名草稿")], confirm: "删除" })) return;
    await act(async () => {
      // Let an in-flight autosave settle so it cannot recreate the deleted row.
      if (flight.current) await flight.current.catch(() => {});
      await request(`/marketing-videos/${p.id}`, { method: "DELETE" });
      if (!session.alive) return;
      library.remove(p.id);
      if (p.id === draftId.current) { setTextPending(false); textRequest.current = null; resetDraft(); }
      setNotice("草稿已删除。关联素材仍在「个人素材」中，如需永久删除请前往删除。");
    });
  }
  async function archive() {
    const p = await save();
    const result = await request<{ itemId: string; version: number }>(`/marketing-videos/${p.id}/archive`, json("POST", {}));
    setCurrent({ ...p, knowledgeItemId: result.itemId, knowledgeVersion: result.version });
    setNotice("视频和发布文案已保存到知识库。");
  }
  async function releaseUnknown(id: string) {
    const released = await request<{ project: Project }>(`/marketing-videos/${id}/unknown-segments/release`, json("POST", {}));
    if (session.alive) setCurrent(normalizeProject(released.project));
    await generate(true);
  }

  const plan = (() => {
    try { return { parts: resolveMarketingSegments(draft, profile), error: "" }; }
    catch (e) { return { parts: [], error: errorMessage(e) }; }
  })();
  const referenceAnalysis = project?.draft.copyMode === draft.copyMode && project.draft.reference === draft.reference && project.draft.referenceUpload?.id === draft.referenceUpload?.id
    ? project.referenceAnalysis : undefined;
  const copyReady = draft.copyMode === "rewrite" ? sourceKind === "upload" ? !!draft.referenceUpload : !!draft.reference.trim() : !!draft.topic.trim();
  const copyAction = <button className="mv-soft" disabled={busy || !copyReady || !ready} onClick={() => void act(writeCopy)}>{t(busy ? "正在处理…" : draft.copyMode === "rewrite" ? "一键拆解并生成" : "生成文案和分镜")}</button>;
  const referenceVideoStatus = profile.imagesWithReferenceVideo
    ? t("已选择参考视频：人物与场景图片合计最多 {0} 张；不生成口播配音，音色设置不生效，可添加背景音乐。", [profile.imagesWithReferenceVideo])
    : t("已选择参考视频：人物与场景图片不参与生成；不生成口播配音，音色设置不生效，可添加背景音乐。");
  const unusableMaterial = Object.entries(draft.assets).some(([slot, value]) => marketingAssetIds(value).some(id => {
    const item = materialFor(materials, slot, id);
    return !item || item.issue;
  }));
  const generationBlocker = !ready ? loadError || "正在加载草稿…"
    : unusableMaterial ? "素材已不可用或不支持新生成，请移除或替换。"
    : marketingReferenceError(draft, profile) || plan.error || (!capabilities?.composition ? "视频合成工具不可用，请配置 FFmpeg 和 FFprobe。" : "");
  const nextStep = (target: number) => { if (target && !draft.script.trim()) setError("请先填写或生成视频文案。"); else setStep(target); };

  const audioNotice = marketingStoryboardAudioMismatch(draft) && !frozen && <StoryboardAudioNotice video={!!draft.assets.video} busy={busy || !ready}
    onRebuild={rebuildStoryboard} onKeep={keepStoryboard} />;
  // Errors and progress stay next to the step buttons instead of the end of a long page.
  const status = <>
    {working && <WaitStatus key={working.started} label={working.label} started={working.started} textRequest={working.textRequest} />}
    {error && <p className="mv-error" role="alert">{t(error)}</p>}
    {!project?.taskId && notice && <p className="mv-notice" role="status">{t(notice)}</p>}
  </>;

  return <div className="mv-scroll"><div className="mv-studio">
    <header className="mv-heading">
      <div><span className="mv-eyebrow">{t("营销影像")}</span><h1>{t("三步，把卖点变成视频。")}</h1><p>{t("15–60 秒 · 自动分镜合成 · 抖音发布素材")}</p></div>
      <button disabled={navigationBusy || saving || !ready} onClick={() => void act(() => newDraft(), true)}>{t("开始新视频")}</button>
    </header>
    {loadError && <div className="mv-connection-error" role="alert"><p>{t(loadError)}</p><button onClick={() => { setLoadError(""); setLoadAttempt(value => value + 1); }}>{t("重新连接")}</button></div>}
    <DraftLibrary projects={library.projects} nextCursor={library.nextCursor} query={library.query} currentId={project?.id}
      openBusy={navigationBusy || saving} moreBusy={navigationBusy} deleteBusy={busy || saving}
      onQuery={library.setQuery} onDelete={p => void deleteDraft(p)} onMore={() => void act(library.loadMore, true)}
      onOpen={p => void act(async () => { if (dirty) await save(); await open(p.id); }, true)} />
    {project && <TextOperationPanel key={project.id} projectId={project.id} reload={operationReload} onState={async operation => { if (project.id === draftId.current) await textOperationState(operation); }} />}
    {!ready && !loadError && <p role="status">{t("正在加载草稿…")}</p>}
    {project?.taskId ? <ResultPanel form={form} project={project} saving={saving} dirty={dirty} knowledge={!!capabilities?.knowledge} notice={notice}
      onCopyDraft={target => void act(() => newDraft(true, target))}
      onResume={() => void act(() => generate(true))}
      onCancel={() => void act(async () => { await api.cancelTask(project.taskId!); await open(project.id); })}
      onRelease={() => void act(() => releaseUnknown(project.id))}
      onPublication={() => void act(() => publication())}
      onCopyText={() => void act(async () => { await save(); await navigator.clipboard.writeText([draft.publishTitle, draft.tags].filter(Boolean).join("\n")); setNotice("已复制"); })}
      onArchive={() => void act(archive)} /> : <>
      <nav className="mv-steps" aria-label={t("视频创作步骤")}>{STEPS.map((label, i) => <button key={label} disabled={busy || !ready} aria-current={i === step ? "step" : undefined} className={i === step ? "active" : ""} onClick={() => nextStep(i)}><span>{i + 1}</span>{t(label)}</button>)}</nav>
      <section className="mv-card"><div className="mv-section-head"><h2>{t(STEPS[step])}</h2><span>{step + 1} / 3</span></div>
        {step === 0 && <CopyStep form={form} inputId={`${generationHintId}-reference`} sourceKind={sourceKind} uploading={uploadingReference} analysis={analysis} planError={plan.error}
          analysisPanel={referenceAnalysis
            ? <ReferenceAnalysisPanel key={`${ownerId}:${referenceAnalysis.id}`} id={referenceAnalysis.id} ownerId={ownerId} onActive={setAnalysisPending} onComplete={completedAnalysis} completedAction={copyAction} disabled={exclusive.busy || textPending || saving || !ready} />
            : copyAction}
          onUploadSource={chooseReferenceSource} onReferenceFile={file => void act(() => selectReferenceVideo(file))}
          onStoryboard={changeStoryboard} onStoryboardAi={aiStoryboard} onPublication={() => void act(() => publication())} />}
        {step === 1 && <MaterialsStep form={form} profile={profile} handlers={materialHandlers} referenceVideoStatus={referenceVideoStatus} onPickPortrait={() => setTwinOpen("portrait")}
          audioNotice={audioNotice} />}
        {step === 2 && <ProductionStep form={form} profile={profile} handlers={materialHandlers} referenceVideoStatus={referenceVideoStatus} parts={plan.parts} planError={plan.error}
          blocker={generationBlocker} blockerId={generationHintId} storyboardPanel={storyboardPanel} audioNotice={audioNotice}
          reviewPanel={!!draft.script.trim() && <section className="mv-review-section" aria-label={t("文案与分镜检查")}>
            <div className="mv-section-head"><h3>{t("文案与分镜检查")}</h3><button disabled={busy || !ready} onClick={() => void act(review)}
              title={t("依据风险词规则表及抖音、小红书社区规则，检查文案、台词、标题标签和分镜内容。")}>{t("检查当前文案")}</button></div>
            {validReview
              ? <ReviewPanel key={project!.reviewedScript} review={project!.review!} draft={draft} busy={busy} onApply={applyReviewEdit} />
              : <p className="mv-hint" role="status">{t("尚未检查，生成视频前会自动检查。")}</p>}
          </section>}
          buttonLabel={busy ? saving ? "正在保存…" : "正在处理…" : draft.storyboard.length ? "确认分镜并生成视频" : "生成分镜并预览"}
          onPickVoice={() => setTwinOpen("voice")} onStoryboard={changeStoryboard} onStoryboardAi={aiStoryboard} onEditCopy={() => setStep(0)}
          onGenerate={() => void act(() => draft.storyboard.length ? generate() : editStoryboard())} onManualStoryboard={() => void act(manualStoryboard)} />}
      </section>
      <div className="mv-dock">
      {status}
      <footer className="mv-footer">
        <button disabled={!step || busy || !ready} onClick={() => setStep(step - 1)}>{t("上一步")}</button>
        <button disabled={busy || saving || !ready || !dirty} onClick={() => void act(async () => { await save(); })}>{t("保存草稿")}</button>
        <span role="status">{t(saving ? "正在保存…" : dirty ? "等待保存" : project ? "草稿已保存" : "")}</span>
        <button className="mv-primary" disabled={step === 2 || busy || !ready} onClick={() => nextStep(step + 1)}>{t("下一步")}</button>
      </footer>
      </div>
    </>}
    {project?.taskId && (working || error) && <div className="mv-dock">{status}</div>}
    {confirmDialog}
    {twinOpen && <DigitalTwinPicker kind={twinOpen} onClose={() => { if (!exclusive.locked) setTwinOpen(null); }} onSelect={async (file, kind) => {
      if (exclusive.locked) throw new Error(t("正在处理…"));
      await exclusive.run(() => selectMaterial(file, kind === "voice" ? "voice" : "portrait"));
    }} />}
  </div></div>;
}

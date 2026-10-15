import { TextOperationPanel } from "./TextOperationPanel.js";
import { useEffect, useId, useRef, useState } from "react";
import { marketingReferenceError, marketingAssetIds, marketingSourceKind, MarketingDraftSchema, planMarketingSegments, timeMarketingStoryboard, resolveMarketingSegments, storyboardScript, marketingReviewText, speechUnits, type MarketingDraft, type MarketingProject } from "@lot-agent/core/marketing-video";
import { api, ApiClientError, request } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { DigitalTwinPicker } from "../digital-twin/DigitalTwinPanel.js";
import { validateTwinFile } from "../digital-twin/media.js";
import { StoryboardEditor } from "./StoryboardEditor.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { readMediaDuration } from "../../lib/video-references.js";
import type { ReferenceAnalysis } from "@lot-agent/core/marketing-analysis";
import { ReferenceAnalysisPanel, analysisError } from "./ReferenceAnalysisPanel.js";

type Asset = { id: string; url: string; name: string; mime: string; issue?: "unsupported" };
type Project = MarketingProject & { assets?: Record<string, Asset> };
type Capabilities = { composition: boolean; knowledge: boolean };
// Persisted drafts and older API responses can predate newly added fields.
// Normalize before storing state or computing the saved/dirty snapshot.
const normalizeProject = (project: Project): Project => ({ ...project, draft: MarketingDraftSchema.parse(project.draft) });
async function requestProject(path: string, init?: RequestInit): Promise<Project> {
  return normalizeProject(await request<Project>(path, init));
}
const STEPS = ["确定文案", "确定素材", "配音与字幕"];
const reviewedText = marketingReviewText;
const json = (method: string, value: unknown) => ({ method, body: JSON.stringify(value) });
const unavailableMessage = "当前服务器尚不支持新版营销视频，请更新服务后重试。";
const errorMessage = (error: unknown) => error instanceof ApiClientError && error.status === 404 && /^(404\s+)?Not Found$/i.test(error.message)
  ? unavailableMessage : error instanceof Error ? error.message : "操作失败，请重试。";

export function ProjectStudio({ ownerId = "", onDraftChange }: { ownerId?: string; onDraftChange?: (dirty: boolean) => void }) {
  const { t, locale } = useI18n();
  const generationHintId = useId();
  const storyboardPanel = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<MarketingDraft>(() => MarketingDraftSchema.parse({}));
  const [project, setProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [assets, setAssets] = useState<Record<string, Asset>>({});
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [step, setStep] = useState(0);
  const [actionBusy, setBusy] = useState(false);
  const [analysisPending, setAnalysisPending] = useState(false);
  const [textPending, setTextPending] = useState(false);
  const [operationReload, setOperationReload] = useState(0);
  const navigationBusy = actionBusy || analysisPending;
  const busy = navigationBusy || textPending; const [saving, setSaving] = useState(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [sourceKind, setSourceKind] = useState<"text" | "video" | "upload">("video");
  const [uploadingReference, setUploadingReference] = useState(false);
  const [analysis, setAnalysis] = useState(""); const [twinOpen, setTwinOpen] = useState<"portrait" | "voice" | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(""); const [loadAttempt, setLoadAttempt] = useState(0);
  const draftRef = useRef(draft); const projectRef = useRef<Project | null>(null);
  const draftId = useRef<string>(crypto.randomUUID()); const version = useRef(0);
  const saved = useRef(JSON.stringify(draft)); const flight = useRef<Promise<Project> | null>(null);
  const epoch = useRef(0); const alive = useRef(true); const lock = useRef(false);
  const textRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const analysisRequest = useRef<{ fingerprint: string; body: unknown } | null>(null);
  const uploadRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const storageKey = `lot:marketing-video:${ownerId}`;
  const setCurrent = (p: Project) => { if (p.id === draftId.current && p.version < version.current) return; projectRef.current = p; setProject(p); setProjects(old => [p, ...old.filter(item => item.id !== p.id)].slice(0, 50)); };
  const remember = (id: string | null) => { try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey); } catch { /* Server drafts remain available. */ } };
  const active = project?.status === "pending" || project?.status === "running";
  const frozen = !!project?.taskId;
  useEffect(() => {
    if (!frozen && step === 2 && draft.storyboard.length) storyboardPanel.current?.scrollIntoView({ block: "start" });
  }, [draft.storyboard.length, frozen, step]);
  const validReview = !!project?.review && project.reviewedScript === reviewedText(draft);
  const dirty = JSON.stringify(draft) !== saved.current;
  const update = (next: MarketingDraft) => { draftRef.current = next; setDraft(next); setError(""); setNotice(""); };
  function field<K extends keyof MarketingDraft>(name: K, value: MarketingDraft[K]) {
    const next = { ...draftRef.current, [name]: value };
    if (value !== draftRef.current[name]) {
      if (name === "script") next.storyboard = [];
      if (name === "durationSec" && next.storyboard.length) {
        try { next.storyboard = timeMarketingStoryboard(next.storyboard, next.durationSec); }
        catch { next.storyboard = []; }
      }
    }

    update(next);
  }
  async function open(id: string) {
    const token = ++epoch.current;
    setTextPending(true);
    const p = await requestProject(`/marketing-videos/${id}`);
    if (!alive.current || token !== epoch.current) return;
    draftId.current = id; version.current = p.version; saved.current = JSON.stringify(p.draft);
    setSourceKind(p.draft.referenceUpload ? "upload" : p.draft.reference.trim() ? marketingSourceKind(p.draft.reference) : "video");
    update(p.draft); setCurrent(p); setAssets(p.assets ?? {}); setStep(p.referenceAnalysis ? 0 : p.draft.storyboard.length ? 2 : 0); setAnalysisPending(!!p.referenceAnalysis && !p.referenceAnalysis.acceptedRevision); setAnalysis(""); remember(id); setOperationReload(n => n + 1);
  }
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    setReady(false); setLoadError("");
    void Promise.all([request<{ data: Project[] }>("/marketing-videos", { signal: controller.signal }), request<Capabilities>("/marketing-videos/capabilities", { signal: controller.signal })]).then(async ([list, caps]) => {
      if (stopped) return;
      setProjects(list.data.map(normalizeProject)); setCapabilities(caps);
      let id: string | null = null; try { id = localStorage.getItem(storageKey); } catch { /* Optional preference. */ }
      if (id && list.data.some(p => p.id === id)) {
        try { await open(id); } catch (e) { if (!stopped) setError(errorMessage(e)); }
      }
      if (!stopped) setReady(true);
    }).catch(e => {
      if (!stopped) setLoadError(e instanceof ApiClientError && e.status === 404 ? unavailableMessage : "营销视频服务暂时无法连接，请重试。");
    }).finally(() => clearTimeout(timeout));
    return () => { stopped = true; alive.current = false; epoch.current++; clearTimeout(timeout); controller.abort(); uploadController.current?.abort(); };
  }, [storageKey, loadAttempt]);
  async function save(): Promise<Project> {
    if (flight.current) { await flight.current; return save(); }
    if (saved.current === JSON.stringify(draftRef.current) && projectRef.current) return projectRef.current;
    const token = epoch.current; const snapshot = draftRef.current;
    setSaving(true);
    const pending = requestProject(`/marketing-videos/${draftId.current}`, json("PUT", { version: version.current, draft: snapshot }));
    flight.current = pending;
    try {
      const p = await pending;
      if (alive.current && token === epoch.current) { version.current = p.version; saved.current = JSON.stringify(snapshot); setCurrent(p); remember(p.id); }
      return p;
    } finally { if (flight.current === pending) flight.current = null; if (alive.current && token === epoch.current) setSaving(false); }
  }
  useEffect(() => {
    if (!ready || busy || !dirty) return;
    const timer = setTimeout(() => { void save().catch(e => { if (alive.current) setError(errorMessage(e)); }); }, 900);
    return () => clearTimeout(timer);
  }, [draft, ready, busy]);
  useEffect(() => { onDraftChange?.(dirty || saving || busy); return () => onDraftChange?.(false); }, [dirty, saving, busy, onDraftChange]);
  useEffect(() => {
    if (!active || !project) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const id = project.id; const token = epoch.current;
    const poll = async () => {
      try {
        const p = await requestProject(`/marketing-videos/${id}`);
        if (!stopped && token === epoch.current) { setCurrent(p); }
      } catch { if (!stopped) setError("暂时无法查询进度，正在重试；请勿重复生成。"); }
      if (!stopped) timer = setTimeout(() => void poll(), 2500);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, project?.id]);
  async function act(work: () => Promise<void>, navigation = false) {
    if (lock.current || analysisPending || (!navigation && textPending) || !ready) return; lock.current = true; setBusy(true); setError("");
    try { await work(); } catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function review() {
    const p = await save();
    const result = await requestProject(`/marketing-videos/${p.id}/review`, json("POST", { locale }));
    if (alive.current) { setCurrent(result); setNotice(""); }
  }
  async function applyReviewEdit(next: MarketingDraft) {
    await act(async () => {
      update(next);
      await review();
    });
  }
  async function writeCopy() {
    const token = epoch.current;
    if (draftRef.current.copyMode === "rewrite" && sourceKind !== "text") {
      const p = await save();
      if (!alive.current || token !== epoch.current) return;
      const fingerprint = JSON.stringify([p.id, p.draft, locale]);
      if (analysisRequest.current?.fingerprint !== fingerprint) analysisRequest.current = { fingerprint, body: {
        ...(sourceKind === "upload" ? { uploadId: p.draft.referenceUpload?.id } : { shareText: p.draft.reference.trim() }),
        clientRequestId: crypto.randomUUID(), target: { projectId: p.id, projectVersion: p.version, locale },
      } };
      try {
        await request<ReferenceAnalysis>("/marketing-video-analyses", json("POST", analysisRequest.current.body));
        if (!alive.current || token !== epoch.current) return;
        await open(p.id);
      } catch (e) {
        // A lost POST response may still have committed the job. Reading its
        // project association recovers it without issuing another model call.
        if (alive.current && token === epoch.current) await open(p.id).catch(() => {});
        throw new Error(analysisError(e));
      }
      return;
    }
    const p = await save();
    if (!alive.current || token !== epoch.current) return;
    const fingerprint = JSON.stringify(["copy", p.id, p.version, p.draft, locale, sourceKind]);
    if (textRequest.current?.fingerprint !== fingerprint) textRequest.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const result = await request<{ project: Project; analysis: string }>("/marketing-videos/copy", json("POST", {
        draft: p.draft, locale, source: { kind: sourceKind === "upload" ? "video" : sourceKind }, projectId: p.id, version: p.version, clientRequestId: textRequest.current.id,
      }));
      if (!alive.current || token !== epoch.current) return;
      const next = normalizeProject(result.project);
      version.current = next.version; saved.current = JSON.stringify(next.draft);
      update(next.draft); setCurrent(next); setAnalysis(result.analysis);
    } finally { if (alive.current && token === epoch.current) setOperationReload(n => n + 1); }
  }
  async function textOperationState(operation?: { id: string; status: string; appliedVersion?: number; result?: { analysis: string } }) {
    setTextPending(!!operation && ["running", "unknown", "needs_apply"].includes(operation.status));
    if (operation?.status === "failed") textRequest.current = null;
    if (operation?.status !== "succeeded" || !operation.appliedVersion || operation.appliedVersion <= version.current || dirty) return;
    const token = epoch.current; const id = draftId.current;
    const p = await requestProject(`/marketing-videos/${id}`);
    if (!alive.current || token !== epoch.current || saved.current !== JSON.stringify(draftRef.current)) return;
    version.current = p.version; saved.current = JSON.stringify(p.draft);
    update(p.draft); setCurrent(p); setAnalysis(operation.result?.analysis ?? "");
  }

  async function completedAnalysis(value: ReferenceAnalysis) {
    if (value.projectId !== draftId.current || saved.current !== JSON.stringify(draftRef.current)) return;
    const token = epoch.current;
    const p = await requestProject(`/marketing-videos/${value.projectId}`);
    if (!alive.current || token !== epoch.current || saved.current !== JSON.stringify(draftRef.current)) return;
    version.current = p.version; saved.current = JSON.stringify(p.draft);
    update(p.draft); setCurrent(p); setAnalysis(value.snapshot.creation?.analysis ?? "");
  }
  async function publication(fillMissing = false) {
    const p = await save();
    const result = await requestProject(`/marketing-videos/${p.id}/publication`, json("POST", { locale, fillMissing }));
    if (!alive.current) return;
    version.current = result.version; saved.current = JSON.stringify(result.draft);
    update(result.draft); setCurrent(result);
  }
  async function generate(retry = false) {
    const referenceError = marketingReferenceError(draftRef.current);
    if (referenceError) { setStep(1); throw new Error(referenceError); }
    if (!retry) resolveMarketingSegments(draftRef.current);
    if (!retry && (!draftRef.current.publishTitle.trim() || !draftRef.current.tags.trim())) await publication(true);
    let p = await save();
    if (!retry && (!p.review || p.reviewedScript !== reviewedText(p.draft))) { await review(); p = projectRef.current!; }
    if (p.review?.verdict === "reject") { setStep(0); throw new Error("请先修改文案中标出的风险内容。"); }
    const result = await requestProject(`/marketing-videos/${p.id}/generate`, json("POST", { version: p.version, retry }));
    if (alive.current) setCurrent(result);
  }
  async function editStoryboard(instruction = "", index?: number) {
    const token = epoch.current;
    const p = await save();
    if (!alive.current || token !== epoch.current) return;
    const fingerprint = JSON.stringify(["storyboard", p.id, p.version, locale, instruction, index]);
    if (textRequest.current?.fingerprint !== fingerprint) textRequest.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const result = await requestProject(`/marketing-videos/${p.id}/storyboard`, json("POST", { version: p.version, locale, instruction, index, clientRequestId: textRequest.current.id }));
      if (!alive.current || token !== epoch.current) return;
      version.current = result.version; saved.current = JSON.stringify(result.draft);
      update(result.draft); setCurrent(result); setNotice("分镜已保存，请确认后生成视频。");
    } finally { if (alive.current && token === epoch.current) setOperationReload(n => n + 1); }
  }

  async function manualStoryboard() {
    const storyboard = planMarketingSegments(draftRef.current.script, draftRef.current.durationSec).map(part => ({
      durationSec: part.durationSec, script: part.script, visual: draftRef.current.background || t("展示产品与使用场景"),
      action: t(draftRef.current.assets.video ? "人物正面出镜，无声展示产品，不做说话口型" : "人物正面出镜，自然讲述并展示产品"), camera: t("中景平稳拍摄，缓慢推近主体"),
    }));
    update({ ...draftRef.current, storyboard, script: storyboardScript(storyboard) });
    await save();
  }
  const imageCount = (slot: keyof MarketingDraft["assets"], value = draftRef.current) => slot === "background" || slot === "scene"
    ? marketingAssetIds(value.assets.background).length + marketingAssetIds(value.assets.scene).length
    : marketingAssetIds(value.assets[slot]).length;
  function chooseReferenceSource(kind: "text" | "video" | "upload") {
    setSourceKind(kind);
    if (kind !== "upload" && draftRef.current.referenceUpload) update({ ...draftRef.current, referenceUpload: undefined });
  }
  async function selectReferenceVideo(file: File) {
    if (!file.size || file.size > 100 * 1024 * 1024 || !["video/mp4", "video/quicktime", "video/webm"].includes(file.type)) throw new Error("本地爆款视频支持 MP4、MOV、WebM，最大 100 MB，最长 180 秒，最高 1080p。");
    const token = epoch.current;
    const duration = await readMediaDuration(file);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 180) throw new Error("参考视频最长 180 秒。");
    if (!alive.current || token !== epoch.current) return;
    const fingerprint = JSON.stringify([ownerId, file.name, file.size, file.lastModified]);
    if (uploadRequest.current?.fingerprint !== fingerprint) uploadRequest.current = { fingerprint, id: crypto.randomUUID() };
    const controller = new AbortController(); uploadController.current = controller; setUploadingReference(true);
    const body = new FormData(); body.append("file", file); body.append("clientRequestId", uploadRequest.current.id);
    try {
      const upload = await request<{ id: string; name: string }>("/marketing-video-analyses/uploads", { method: "POST", body, signal: controller.signal });
      if (!alive.current || token !== epoch.current) return;
      update({ ...draftRef.current, reference: "", referenceUpload: upload });
      await save();
    } catch (error) {
      if (error instanceof ApiClientError && ["UPLOAD_EXPIRED", "REQUEST_CONFLICT"].includes(error.code ?? "")) uploadRequest.current = null;
      throw new Error(analysisError(error));
    } finally {
      if (uploadController.current === controller) uploadController.current = null;
      if (alive.current && token === epoch.current) setUploadingReference(false);
    }
  }
  async function selectAsset(file: File, slot: keyof MarketingDraft["assets"]) {
    const multiple = ["portrait", "background", "scene"].includes(slot);
    if (multiple && imageCount(slot) >= 3) throw new Error("人物或场景区域各最多 3 张。");
    const token = epoch.current;
    if (slot === "scene" || slot === "voice" || slot === "portrait" || slot === "background" || slot === "cover") await validateTwinFile(file, slot === "voice" ? "voice" : "portrait");
    else if (slot === "video") {
      if (draftRef.current.assets.video) throw new Error("参考视频最多 1 个，请先移除已有视频。");
      if (!file.size || file.size > 150 * 1024 * 1024 || !["video/mp4", "video/quicktime"].includes(file.type)) throw new Error("参考视频支持 MP4、MOV，最大 150 MB，时长 3–15.5 秒。");
      const duration = await readMediaDuration(file);
      if (!Number.isFinite(duration) || duration < 3 || duration > 15.5) throw new Error("参考视频支持 MP4、MOV，最大 150 MB，时长 3–15.5 秒。");
    } else {
      if (!file.size || file.size > 30 * 1024 * 1024 || !["audio/mpeg", "audio/wav", "audio/mp4"].includes(file.type)) throw new Error("背景音乐支持 MP3、WAV、M4A，最大 30 MB。");
      if (await readMediaDuration(file) > 600) throw new Error("背景音乐最长 10 分钟。");
    }
    const value = await api.uploadFile(file);
    if (!alive.current || token !== epoch.current) return;
    setAssets(old => ({ ...old, [multiple ? value.assetId : slot]: { id: value.assetId, url: value.url, name: file.name, mime: value.mime } }));
    field("assets", { ...draftRef.current.assets, [slot]: multiple ? [...marketingAssetIds(draftRef.current.assets[slot]), value.assetId] : value.assetId });
  }
  async function newDraft(copy = false, editShots = false) {
    setTextPending(false); textRequest.current = null;
    if (dirty) await save();
    epoch.current++; draftId.current = crypto.randomUUID(); version.current = 0; projectRef.current = null; setProject(null); setAnalysisPending(false); analysisRequest.current = null;
    const next = copy ? { ...draftRef.current } : MarketingDraftSchema.parse({});
    saved.current = copy ? "" : JSON.stringify(next);
    setSourceKind(next.referenceUpload ? "upload" : copy && next.reference.trim() ? marketingSourceKind(next.reference) : "video");
    update(next); if (!copy) setAssets({}); setStep(editShots ? 2 : 0); setAnalysis(""); remember(null);
  }
  const choices = (label: string, values: { value: string; label: string }[], value: string, choose: (value: string) => void) => <div className="mv-choices" role="group" aria-label={t(label)}>{values.map(item => <button key={item.value} type="button" disabled={busy || frozen || !ready} className={value === item.value ? "selected" : ""} aria-pressed={value === item.value} onClick={() => choose(item.value)}>{t(item.label)}</button>)}</div>;
  const textField = (name: "topic" | "reference" | "script" | "background" | "publishTitle" | "tags", label: string, max: number, rows = 2) => <label className="mv-field"><span>{t(label)}</span><textarea value={draft[name]} rows={rows} maxLength={max} disabled={busy || !ready || (frozen && !["publishTitle", "tags"].includes(name))} onChange={e => field(name, e.target.value)} /></label>;
  const asset = (slot: keyof MarketingDraft["assets"], label: string, accept: string) => {
    const multiple = ["portrait", "background", "scene"].includes(slot);
    const ids = marketingAssetIds(draft.assets[slot]);
    return <div className="mv-upload"><label className="mv-upload-button">{t(label)}<input aria-label={t(label)} type="file" accept={accept} multiple={multiple} disabled={busy || frozen || !ready || (slot === "video" && !!draft.assets.video) || (multiple && imageCount(slot, draft) >= 3)} onChange={e => {
      const files = Array.from(e.target.files ?? []); e.target.value = "";
      if (files.length) void act(async () => {
        if (slot === "video" && files.length > 1) throw new Error("参考视频最多 1 个，请先移除已有视频。");
        if (multiple && imageCount(slot) + files.length > 3) throw new Error("人物或场景区域各最多 3 张。");
        for (const file of files) await selectAsset(file, slot);
      });
    }} /></label>{ids.map(id => {
      const item = assets[id] ?? (assets[slot]?.id === id ? assets[slot] : undefined);
      return <div key={id} className="mv-asset-preview">{item && (item.mime.startsWith("audio/") ? <audio controls src={item.url} aria-label={t("声音试听")} /> : item.mime.startsWith("video/") ? <video controls preload="metadata" src={item.url} aria-label={t("参考视频预览")} /> : <img src={item.url} alt={t(label)} />)}<span>{item?.name ?? t(label)}</span><button disabled={busy || frozen} onClick={() => {
        const next = { ...draftRef.current.assets };
        const remaining = ids.filter(value => value !== id);
        if (multiple && remaining.length) next[slot as "portrait" | "background" | "scene"] = remaining;
        else delete next[slot];
        field("assets", next);
      }}>{t("移除")}</button>{(!item || item.issue) && <p className="mv-error">{t(!item ? "素材已不可用，请移除或替换后生成。" : "此历史素材不支持新生成，请移除或替换。")}</p>}</div>;
    })}</div>;
  };
  const plan = (() => {
    try { return { parts: resolveMarketingSegments(draft), error: "" }; }
    catch (e) { return { parts: [], error: errorMessage(e) }; }
  })();
  const parts = plan.parts;
  const generationBlocker = !ready ? loadError || "正在加载草稿…"
    : Object.entries(draft.assets).some(([slot, value]) => marketingAssetIds(value).some(id => {
      const item = assets[id] ?? (assets[slot]?.id === id ? assets[slot] : undefined);
      return !item || item.issue;
    })) ? "素材已不可用或不支持新生成，请移除或替换。"
    : marketingReferenceError(draft) || plan.error || (!capabilities?.composition ? "视频合成工具不可用，请配置 FFmpeg 和 FFprobe。" : "");

  return <div className="mv-scroll"><div className="mv-studio">
    <header className="mv-heading"><div><span className="mv-eyebrow">{t("营销影像")}</span><h1>{t("三步，把卖点变成视频。")}</h1><p>{t("15–60 秒 · 自动分镜合成 · 抖音发布素材")}</p></div><button disabled={navigationBusy || saving || !ready} onClick={() => void act(() => newDraft(), true)}>{t("开始新视频")}</button></header>
    {loadError && <div className="mv-connection-error" role="alert"><p>{t(loadError)}</p><button onClick={() => { setLoadError(""); setLoadAttempt(value => value + 1); }}>{t("重新连接")}</button></div>}
    <details className="mv-library"><summary>{t("我的视频草稿")} · {projects.length}</summary><div className="mv-draft-list">{projects.map(p => <button key={p.id} disabled={navigationBusy || saving} aria-pressed={p.id === project?.id} onClick={() => void act(async () => { if (dirty) await save(); await open(p.id); }, true)}><strong>{p.draft.publishTitle || p.draft.topic || t("未命名草稿")}</strong><span>{p.draft.durationSec}s · {t(({ draft: "草稿", pending: "等待生成", running: "生成中", succeeded: "已生成", failed: "生成失败", cancelled: "已取消" } as Record<string, string>)[p.status] ?? p.status)}</span></button>)}</div></details>
    {project && <TextOperationPanel key={project.id} projectId={project.id} reload={operationReload} onState={async operation => { if (project.id === draftId.current) await textOperationState(operation); }} />}
    {!ready && !loadError && <p role="status">{t("正在加载草稿…")}</p>}
    {project?.taskId ? <section className="mv-card mv-results"><div className="mv-section-head"><h2>{t("生成结果")}</h2><button disabled={busy || saving} onClick={() => void act(() => newDraft(true))}>{t("复制为新草稿")}</button></div>
      {project.status === "succeeded" && project.output?.assets?.[0] ? <><video className="mv-result-video" controls src={project.output.assets[0].url} /><a className="mv-download" href={project.output.assets[0].url} download>{t("下载视频")}</a></> : <div className="mv-progress"><strong>{t(active ? "正在制作完整视频" : project.status === "cancelled" ? "已取消" : "生成失败")}</strong><progress aria-label={t("视频制作进度")} max="100" value={project.progress} /><span>{project.progress}% · {project.stage?.startsWith("片段完成 ") ? t("片段完成 {0}", [project.stage.slice(5)]) : t(project.stage || "等待生成")}</span>{project.status === "pending" && <button disabled={busy} onClick={() => void act(() => generate(true))}>{t("恢复排队任务")}</button>}{active && <button disabled={busy} onClick={() => void act(async () => { await api.cancelTask(project.taskId!); await open(project.id); })}>{t("取消")}</button>}{!active && <button disabled={busy} onClick={() => void act(() => generate(true))}>{t("继续未完成的任务")}</button>}{project.error && <p className="mv-error">{t(project.error)}</p>}<p className="mv-hint">{t("成功片段会保留。重新生成失败片段可能产生费用；提交结果未知时不会自动重发。")}</p></div>}
      <div className="mv-publication"><button disabled={busy} onClick={() => void act(() => publication())}>{t("重新生成标题和标签")}</button>{textField("publishTitle", "视频发布标题", 100)}{textField("tags", "短视频检索标签", 160)}<div className="mv-choices"><button disabled={busy} onClick={() => void act(async () => { await save(); await navigator.clipboard.writeText([draft.publishTitle, draft.tags].filter(Boolean).join("\n")); setNotice("已复制"); })}>{t("复制发布文案")}</button><button disabled={busy || project.status !== "succeeded" || !capabilities?.knowledge} onClick={() => void act(async () => { const p = await save(); const result = await request<{ itemId: string; version: number }>(`/marketing-videos/${p.id}/archive`, json("POST", {})); setCurrent({ ...p, knowledgeItemId: result.itemId, knowledgeVersion: result.version }); setNotice("视频和发布文案已保存到知识库。"); })}>{t(project.knowledgeItemId ? project.knowledgeVersion === project.version && !dirty ? "已存入知识库" : "更新知识库草稿" : "存草稿到知识库")}</button><button disabled title={t("抖音发布权限尚未接入，请下载视频并复制文案发布。")}>{t("发布到抖音")}</button></div>{notice && <p className="mv-hint" role="status">{t(notice)}</p>}<p className="mv-hint">{t("抖音发布权限尚未接入，请下载视频并复制文案发布。")}</p>{!capabilities?.knowledge && <p className="mv-hint">{t("知识库尚未启用。")}</p>}</div>
      <details className="mv-script-review" open><summary>{t("查看制作分镜")}</summary>{draft.storyboard.length ? <StoryboardEditor presenterRequired={draft.mode === "avatar"} shots={draft.storyboard} busy={busy} readOnly /> : <p className="mv-hint">{t("旧视频未保存详细分镜，可复制草稿补充分镜后重新制作。")}</p>}<button disabled={busy || saving} onClick={() => void act(() => newDraft(true, true))}>{t("修改分镜并重新制作")}</button></details>
    </section> : <>
      <nav className="mv-steps" aria-label={t("视频创作步骤")}>{STEPS.map((label, i) => <button key={label} disabled={busy || !ready} aria-current={i === step ? "step" : undefined} className={i === step ? "active" : ""} onClick={() => { if (i && !draft.script.trim()) setError("请先填写或生成视频文案。"); else setStep(i); }}><span>{i + 1}</span>{t(label)}</button>)}</nav>
      <section className="mv-card"><div className="mv-section-head"><h2>{t(STEPS[step])}</h2><span>{step + 1} / 3</span></div>
        {step === 0 && <>
          {choices("文案方式", [{ value: "generate", label: "智能生成文案" }, { value: "rewrite", label: "拆解爆款文案" }], draft.copyMode, value => field("copyMode", value as MarketingDraft["copyMode"]))}
          {draft.copyMode === "rewrite" ? <>
            <div className="mv-reference-input">
              <div className="mv-reference-heading">
                <label htmlFor={`${generationHintId}-reference`}>{t("视频链接或参考文案")}</label>
                <div className="mv-source-options" role="group" aria-label={t("参考内容类型")}>
                  {(["video", "text", "upload"] as const).map(kind => <label key={kind} className={sourceKind === kind ? "selected" : ""}>
                    <input type="checkbox" checked={sourceKind === kind} disabled={busy || frozen || !ready} onChange={() => chooseReferenceSource(kind)} />
                    {t(kind === "video" ? "视频链接" : kind === "text" ? "文字文案" : "上传本地爆款视频")}
                  </label>)}
                </div>
              </div>
              {sourceKind === "upload" ? <div className="mv-upload">
                <label className="mv-upload-button">{t(uploadingReference ? "正在上传本地视频…" : draft.referenceUpload ? "替换本地爆款视频" : "选择本地视频文件")}
                  <input type="file" accept="video/mp4,video/quicktime,video/webm" aria-label={t("选择本地视频文件")} disabled={busy || frozen || !ready} onChange={e => {
                    const file = e.target.files?.[0]; e.target.value = ""; if (file) void act(() => selectReferenceVideo(file));
                  }} />
                </label>
                {draft.referenceUpload && <div className="mv-local-reference"><span>{draft.referenceUpload.name}</span><button type="button" disabled={busy || frozen || !ready} onClick={() => field("referenceUpload", undefined)}>{t("移除")}</button></div>}
                <p className="mv-hint">{t("本地爆款视频支持 MP4、MOV、WebM，最大 100 MB，最长 180 秒，最高 1080p。")}</p>
              </div> : <textarea id={`${generationHintId}-reference`} value={draft.reference} rows={4} maxLength={6000} disabled={busy || frozen || !ready} onChange={e => field("reference", e.target.value)} />}
            </div>
            <p className="mv-hint">{t(sourceKind === "upload" ? "上传后点击一键拆解并生成，AI 读取视频画面、字幕和台词，生成文案与分镜。原视频私有保存 7 天。" : "粘贴视频链接、分享文本或文案，AI 自动拆解并生成文案和分镜。")}</p>
            <p className="mv-hint">{t("拆解素材用于参考文案和结构，不会自动用于视频生成；需要画面参考时，请在“确定素材”中添加。")}</p>
            <details className="mv-creative-brief" open><summary>{t("补充产品与创作要求（选填）")}</summary>{textField("topic", "产品、卖点和目标顾客", 800)}</details>
          </> : textField("topic", "产品、卖点和目标顾客", 800)}
          <label className="mv-field"><span>{t("整片时长（秒）")} · {draft.durationSec}s</span><input type="range" min="15" max="60" step="1" aria-label={t("整片时长（秒）")} value={draft.durationSec} disabled={busy} onChange={e => field("durationSec", Number(e.target.value))} /></label>
          <p className="mv-hint">{t("选择 15–60 秒目标时长，AI 自动安排每镜 4–15 秒，可多出最多 5 秒，成片最长 65 秒。")}</p>
          <button className="mv-soft" disabled={busy || !(draft.copyMode === "rewrite" ? sourceKind === "upload" ? !!draft.referenceUpload : draft.reference.trim() : draft.topic.trim()) || !ready} onClick={() => void act(writeCopy)}>{t(busy ? "正在处理…" : draft.copyMode === "rewrite" ? "一键拆解并生成" : "生成文案和分镜")}</button>
          {project?.referenceAnalysis && <ReferenceAnalysisPanel key={`${ownerId}:${project.referenceAnalysis.id}`} id={project.referenceAnalysis.id} ownerId={ownerId} onActive={setAnalysisPending} onComplete={completedAnalysis} />}
          {analysis && <details className="mv-script-review"><summary>{t("文案结构")}</summary><p>{analysis}</p></details>}
          {(draft.copyMode !== "rewrite" || !!draft.script.trim()) && <>
          {textField("script", "视频口播文案", 2000, 6)}<p className="mv-hint">{t("预计口播 {0} 秒，实际以成片为准。", [Math.ceil(speechUnits(draft.script) / 4)])}</p>
          {!!draft.storyboard.length && <StoryboardEditor presenterRequired={draft.mode === "avatar"} creation shots={draft.storyboard} busy={busy} onChange={storyboard => update({ ...draftRef.current, storyboard, script: storyboardScript(storyboard) })} onAi={(instruction, index) => void act(() => editStoryboard(instruction, index))} />}
          {draft.script.trim() && plan.error && <p className="mv-error" role="alert">{t(plan.error)}</p>}
          <details className="mv-script-review"><summary>{t("标题标签")}</summary>{textField("publishTitle", "视频发布标题", 100)}{textField("tags", "短视频检索标签", 160)}<button disabled={busy || !ready || !draft.script.trim()} onClick={() => void act(() => publication())}>{t("重新生成标题和标签")}</button></details>
          </>}
        </>}
        {step === 1 && <>
          <p className="mv-hint">{t("肖像用于确定出镜人物，第一张为主要参考，其余请使用同一人的照片；留空时由模型安排人物。")}</p>
          <section className="mv-material-group" aria-label={t("人物")}>
            <div className="mv-material-heading"><strong>{t("人物")}</strong><span>{t("合计最多 3 张（已选 {0} 张）", [imageCount("portrait", draft)])}</span></div>
            <div className="mv-columns"><div className="mv-upload"><button className="mv-upload-button" disabled={busy || frozen || !ready || imageCount("portrait", draft) >= 3} onClick={() => setTwinOpen("portrait")}>{t("选择数字分身素材")}</button></div>{asset("portrait", "上传肖像图片（选填）", "image/jpeg,image/png,image/webp")}</div>
          </section>
          <section className="mv-material-group" aria-label={t("场景")}>
            <div className="mv-material-heading"><strong>{t("场景")}</strong><span>{t("合计最多 3 张（已选 {0} 张）", [imageCount("scene", draft)])}</span></div>
            <div className="mv-columns">{asset("background", "上传背景图片（选填）", "image/jpeg,image/png,image/webp")}{asset("scene", "上传场景图片（选填）", "image/jpeg,image/png,image/webp")}</div>
            <p className="mv-hint">{t("背景图参考环境与空间布局，场景图参考构图与物品细节。图片中的其他人物不会作为主角；每镜按分镜选用相关内容。")}</p>
          </section>
          <section className="mv-material-group" aria-label={t("参考视频")}>
            <div className="mv-material-heading"><strong>{t("参考视频")}</strong><span>{t("最多 1 个")}</span></div>
            {asset("video", "上传参考视频（选填）", "video/mp4,video/quicktime")}
            <p className="mv-hint">{t("参考视频支持 MP4、MOV，最大 150 MB，时长 3–15.5 秒。")}</p>
            <p className="mv-hint">{t("此处视频参与生成，用于参考动作和构图；成片内容以已确认的文案与分镜为准，不沿用原视频台词或音乐。")}</p>
            {draft.assets.video && <p className="mv-hint" role="status">{t("已选择参考视频：人物与场景图片合计最多 3 张；不生成口播配音，音色设置不生效，可添加背景音乐。")}</p>}
            {marketingReferenceError(draft) && <p className="mv-error" role="alert">{t(marketingReferenceError(draft))}</p>}
          </section>
          {textField("background", "背景/场景补充描述", 600)}
        </>}
        {step === 2 && <>{draft.assets.video ? <p className="mv-hint" role="status">{t("已选择参考视频：人物与场景图片合计最多 3 张；不生成口播配音，音色设置不生效，可添加背景音乐。")}</p> : <><label className="mv-label">{t("旁白风格")}</label>{choices("旁白风格", ["自然旁白", "温柔女声", "沉稳男声", "活力讲述"].map(value => ({ value, label: value })), draft.voice, value => field("voice", value))}<button className="mv-soft" disabled={busy || frozen || !ready} onClick={() => setTwinOpen("voice")}>{t("选择数字分身音色")}</button>{asset("voice", "上传音色样例（选填，2–15 秒）", "audio/mpeg,audio/wav")}<p className="mv-hint">{t("音色样例选填，可使用数字分身中的声音或自行上传；留空时按所选旁白风格使用模型原生配音，发布前请试听成片。")}</p></>}{asset("music", "选择背景音乐（选填）", "audio/mpeg,audio/wav,audio/mp4")}{draft.assets.music && <label className="mv-field"><span>{t("背景音乐音量")}</span><input aria-label={t("背景音乐音量")} type="range" min="0" max="0.5" step="0.01" value={draft.musicVolume} disabled={busy} onChange={e => field("musicVolume", Number(e.target.value))} /></label>}
          <label className="mv-checkbox"><input type="checkbox" checked={draft.subtitles} disabled={busy} onChange={e => field("subtitles", e.target.checked)} />{t("添加字幕")}</label><p className="mv-hint">{t("字幕由视频模型根据提示词生成，发布前请检查文字与音画是否一致。")}</p>
          <label className="mv-label">{t("画面比例")}</label>{choices("画面比例", ["9:16", "16:9", "1:1"].map(value => ({ value, label: value })), draft.ratio, value => field("ratio", value as MarketingDraft["ratio"]))}
          {choices("视频质量", [{ value: "720p", label: "默认" }, { value: "1080p", label: "高清" }], draft.quality, value => field("quality", value as MarketingDraft["quality"]))}
          {!draft.storyboard.length && !!parts.length && <details className="mv-script-review"><summary>{t("查看自动分段（{0} 段）", [parts.length])}</summary>{parts.map(p => <p key={p.index}>{p.index + 1} · {p.durationSec}s<br />{p.script}</p>)}</details>}
          <p className="mv-hint">{t("目标 {0} 秒，分镜共 {1} 秒，分 {2} 段生成。", [draft.durationSec, parts.reduce((sum, part) => sum + part.durationSec, 0), parts.length])}</p>
          {!!draft.storyboard.length && <div ref={storyboardPanel} className="mv-storyboard-panel"><StoryboardEditor presenterRequired={draft.mode === "avatar"} shots={draft.storyboard} busy={busy} onChange={storyboard => update({ ...draftRef.current, storyboard, script: storyboardScript(storyboard) })} onAi={(instruction, index) => void act(() => editStoryboard(instruction, index))} /></div>}
          {!draft.storyboard.length && <p className="mv-hint">{t("先生成可编辑分镜，确认后再制作视频。")}</p>}
          {generationBlocker && <div id={generationHintId} role="alert"><p className="mv-error">{t(generationBlocker)}</p>{plan.error && !draft.storyboard.length && <button disabled={busy || !ready} onClick={() => setStep(0)}>{t("修改文案或时长")}</button>}</div>}
          <button className="mv-primary mv-generate" disabled={busy || !!generationBlocker} aria-describedby={generationBlocker ? generationHintId : undefined} onClick={() => void act(() => draft.storyboard.length ? generate() : editStoryboard())}>{t(busy ? saving ? "正在保存…" : "正在处理…" : draft.storyboard.length ? "确认分镜并生成视频" : "生成分镜并预览")}</button>
          {!draft.storyboard.length && <button disabled={busy || !!generationBlocker} onClick={() => void act(manualStoryboard)}>{t("手动编排分镜")}</button>}
        </>}
        {!!draft.script.trim() && <section className="mv-review-section" aria-label={t("文案与分镜检查")}>
          <div className="mv-section-head"><h3>{t("文案与分镜检查")}</h3><button disabled={busy || !ready} onClick={() => void act(review)}>{t("检查当前文案")}</button></div>
          <p className="mv-hint">{t("依据风险词规则表及抖音、小红书社区规则，检查文案、台词、标题标签和分镜内容。")}</p>
          {!draft.storyboard.length && <p className="mv-hint">{t("尚未生成分镜，生成后请再次检查画面、动作和镜头内容。")}</p>}
          {validReview
            ? <ReviewPanel key={project!.reviewedScript} review={project!.review!} draft={draft} busy={busy} onApply={applyReviewEdit} />
            : <p className="mv-hint" role="status">{t("当前内容尚未检查，修改后需要重新检查。")}</p>}
        </section>}
      </section>
      <footer className="mv-footer"><button disabled={!step || busy || !ready} onClick={() => setStep(step - 1)}>{t("上一步")}</button><button disabled={busy || saving || !ready || !dirty} onClick={() => void act(async () => { await save(); })}>{t("保存草稿")}</button><span role="status">{t(saving ? "正在保存…" : dirty ? "等待保存" : project ? "草稿已保存" : "")}</span><button className="mv-primary" disabled={step === 2 || busy || !ready} onClick={() => { if (!draft.script.trim()) setError("请先填写或生成视频文案。"); else setStep(step + 1); }}>{t("下一步")}</button></footer>
    </>}
    {error && <p className="mv-error" role="alert">{t(error)}</p>}{!project?.taskId && notice && <p className="mv-hint" role="status">{t(notice)}</p>}
    {twinOpen && <DigitalTwinPicker kind={twinOpen} onClose={() => { if (!lock.current) setTwinOpen(null); }} onSelect={async (file, kind) => {
      if (lock.current) throw new Error(t("正在处理…"));
      lock.current = true; setBusy(true);
      try { await selectAsset(file, kind === "voice" ? "voice" : "portrait"); }
      finally { lock.current = false; if (alive.current) setBusy(false); }
    }} />}
  </div></div>;
}

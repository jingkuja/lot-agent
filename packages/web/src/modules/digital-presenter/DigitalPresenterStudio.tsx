import { useEffect, useRef, useState } from "react";
import { planPresenterSegments, presenterMaterialBlocker, presenterSpeechBlocker, presenterTakesIssue, PresenterDraftSchema, type PresenterDraft, type PresenterReview, type PresenterTake, type PresenterTaskState } from "@lot-agent/core/digital-presenter";
import { api } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { DigitalTwinPicker } from "../digital-twin/DigitalTwinPanel.js";
import { validateTwinFile } from "../digital-twin/media.js";
import { useConfirm } from "../marketing-video/ConfirmDialog.js";
import { WaitStatus } from "../marketing-video/WaitStatus.js";
import { useDraftSession, useExclusive } from "../marketing-video/session.js";
import { presenterApi, usePresenterPolling, type Capabilities, type Material, type MaterialSlot, type Project } from "./api.js";
import { PresenterStep, ReviewSection, ScriptStep, TakesStep, type PresenterForm } from "./PresenterSteps.js";
import { PresenterResult } from "./PresenterResult.js";
import "../marketing-video/marketing-video.css";
import "./digital-presenter.css";

const STEPS = ["口播文案", "形象与声音", "配音与生成"];
const statusLabels: Record<string, string> = { draft: "草稿", pending: "等待生成", running: "生成中", succeeded: "已生成", failed: "生成未完成", cancelled: "已取消" };
const message = (error: unknown) => error instanceof Error ? error.message : "操作失败，请稍后重试。";
const snapshot = (draft: PresenterDraft) => JSON.stringify(PresenterDraftSchema.parse(draft));

/** Talking-presenter videos in the user's cloned voice: script, presenter and voice, takes, generation. */
export function DigitalPresenterStudio({ ownerId, onDraftChange }: { ownerId?: string; onDraftChange?: (dirty: boolean) => void }) {
  const { t, locale } = useI18n();
  const session = useDraftSession();
  const exclusive = useExclusive(session);
  const [confirmDialog, confirm] = useConfirm();
  const storageKey = `lot:digital-presenter:last:${ownerId ?? "anonymous"}`;
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [project, setProject] = useState<Project>();
  const [draft, setDraft] = useState<PresenterDraft>(() => PresenterDraftSchema.parse({}));
  const [saved, setSaved] = useState(() => snapshot(PresenterDraftSchema.parse({})));
  const [materials, setMaterials] = useState<Partial<Record<MaterialSlot, Material>>>({});
  const [takes, setTakes] = useState<PresenterTake[] | null>(null);
  const [step, setStep] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState<{ label: string; started: number; textRequest: boolean } | null>(null);
  const [picker, setPicker] = useState<"portrait" | "faceReference" | "voice" | null>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const savedRef = useRef(saved); savedRef.current = saved;
  const projectRef = useRef(project); projectRef.current = project;
  const idRef = useRef<string>(crypto.randomUUID());
  const dirty = snapshot(draft) !== saved;
  // The last check of this draft stays visible after edits, so its findings can be fixed one by one.
  const [lastReview, setLastReview] = useState<{ id: string; review: PresenterReview } | null>(null);
  useEffect(() => { if (!dirty && project?.review) setLastReview({ id: project.id, review: project.review }); }, [dirty, project?.id, project?.review]);
  const busy = exclusive.busy || !ready;
  const locked = busy || !!project?.taskId;
  useEffect(() => { onDraftChange?.(dirty); }, [dirty]);

  const remember = (id?: string) => { try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey); } catch { /* Server drafts remain available. */ } };
  function apply(p: Project, keepEdits = false) {
    if (!session.alive) return;
    setProject(p); projectRef.current = p; idRef.current = p.id;
    if (p.materials) setMaterials(p.materials);
    setSaved(snapshot(p.draft)); savedRef.current = snapshot(p.draft);
    if (!keepEdits) { setDraft(p.draft); draftRef.current = p.draft; }
    setProjects(old => [p, ...old.filter(item => item.id !== p.id)]);
    remember(p.id);
  }
  async function loadTakes(p = projectRef.current) {
    if (!p || presenterSpeechBlocker(p.draft)) { setTakes(null); return; }
    const token = session.token();
    const result = await presenterApi.takes(p.id).catch(() => null);
    if (session.current(token)) setTakes(result?.version === p.version ? result.takes : null);
  }
  async function open(id: string) {
    session.next();
    const p = await presenterApi.get(id);
    setTakes(null); setError(""); setNotice("");
    apply(p);
    setStep(p.draft.script.trim() ? 2 : 0);
    await loadTakes(p);
  }
  function fresh(copy?: PresenterDraft) {
    session.next();
    const next = PresenterDraftSchema.parse(copy ?? {});
    idRef.current = crypto.randomUUID();
    setProject(undefined); projectRef.current = undefined;
    setDraft(next); draftRef.current = next;
    setSaved(snapshot(PresenterDraftSchema.parse({}))); savedRef.current = snapshot(PresenterDraftSchema.parse({}));
    setTakes(null); setStep(0); setError(""); setNotice("");
    if (!copy) setMaterials({});
    remember();
  }
  useEffect(() => {
    let last: string | null = null;
    try { last = localStorage.getItem(storageKey); } catch { /* Optional preference. */ }
    void (async () => {
      try {
        const [caps, list] = await Promise.all([presenterApi.capabilities(), presenterApi.list()]);
        if (!session.alive) return;
        setCapabilities(caps); setProjects(list.data); setNextCursor(list.nextCursor);
        if (last && /^[a-f0-9-]{36}$/i.test(last)) await open(last).catch(() => remember());
      } catch (e) { if (session.alive) setError(message(e)); }
      finally { if (session.alive) setReady(true); }
    })();
  }, []);

  /** Saves the current draft and returns the saved project, so server actions see what is on screen. */
  async function save(): Promise<Project> {
    const current = projectRef.current;
    if (current?.taskId || (current && snapshot(draftRef.current) === savedRef.current)) return current!;
    const p = await presenterApi.save(idRef.current, current?.version ?? 0, draftRef.current);
    apply(p, true);
    return p;
  }
  async function act(label: string, work: () => Promise<void>, textRequest = false) {
    await exclusive.run(async () => {
      setError(""); setNotice("");
      setWorking(label ? { label, started: Date.now(), textRequest } : null);
      try { await work(); }
      catch (e) { if (session.alive) setError(message(e)); }
      finally { if (session.alive) setWorking(null); }
    });
  }
  const set: PresenterForm["set"] = (key, value) => {
    const next = { ...draftRef.current, [key]: value };
    draftRef.current = next; setDraft(next);
    if (key === "voice" || key === "script") setTakes(null);
  };
  const form: PresenterForm = { draft, busy, locked, set };

  async function writeScript() {
    const { script } = await presenterApi.script(draft.topic, draft.durationSec, locale);
    set("script", script);
    await save();
  }
  async function review() {
    const p = await save();
    apply(await presenterApi.review(p.id, p.version, locale), true);
  }
  /** A fix from the check only saves the script; the user checks again when ready. The takes of
   * the old text no longer apply, so they are reloaded for the new one. */
  async function applyScript(script: string) {
    set("script", script);
    await save();
    await loadTakes();
  }
  async function synthesize(slots?: number[]) {
    const p = await save();
    const token = session.token();
    const result = await presenterApi.synthesize(p.id, p.version, slots);
    if (!session.current(token)) return;
    setTakes(result.takes);
    if (result.error) setError(result.error);
  }
  async function upload(slot: MaterialSlot, file: File) {
    if (slot === "baseVideo") {
      if (!["video/mp4", "video/quicktime"].includes(file.type) || !file.size || file.size > 150 * 1024 * 1024) throw new Error("口播底片支持 MP4、MOV，最大 150 MB。");
    } else await validateTwinFile(file, "portrait");
    const token = session.token();
    const value = await api.uploadFile(file, undefined, "marketing-video");
    if (!session.current(token)) return;
    setMaterials(old => ({ ...old, [slot]: { id: value.assetId, url: value.url, name: file.name, mime: value.mime } }));
    set(slot, value.assetId);
    await save();
  }
  async function generate() {
    const p = await save();
    const ok = await confirm({ title: "生成主播视频？", message: draft.mode === "image"
      ? "将按 {0} 段配音逐段提交数字人视频模型，按生成秒数由模型账号计费。提交后草稿不可修改，可复制为新草稿。"
      : "将提交一次视频口型替换，按成片秒数由模型账号计费。提交后草稿不可修改，可复制为新草稿。", values: [takes?.length ?? 0], confirm: "确认生成" });
    if (!ok) return;
    apply(await presenterApi.generate(p.id, p.version));
  }
  const onState = (state: PresenterTaskState) => {
    const current = projectRef.current;
    if (!current || current.id !== state.id) return;
    const next = { ...current, ...state };
    setProject(next); projectRef.current = next;
    if (state.status === "succeeded" || state.status === "failed" || state.status === "cancelled") void presenterApi.get(state.id).then(p => { if (projectRef.current?.id === p.id) apply(p); }, () => {});
  };
  usePresenterPolling(project?.id, !!project?.taskId && ["pending", "running"].includes(project.status), onState);

  const plan = planPresenterSegments(draft.script, draft.voice.speed);
  const takeMs = takes?.flatMap(take => take.durationMs === undefined ? [] : [take.durationMs]) ?? [];
  const blocker = !capabilities?.composition ? "视频合成工具不可用，请配置 FFmpeg 和 FFprobe。"
    : draft.subtitles && !capabilities.subtitles ? "当前环境不支持字幕，可关闭字幕后生成。"
    : plan.error || presenterMaterialBlocker(draft) || presenterSpeechBlocker(draft)
    || (!takes || takeMs.length !== plan.segments.length ? "请先生成全部配音并试听。" : presenterTakesIssue(draft.mode, takeMs))
    || (!project?.review || dirty ? "请先完成当前文案检查。" : project.review.verdict === "reject" ? "文案检查存在高风险内容，请修改后重新检查。" : "");
  const currentReview = dirty ? undefined : project?.review;
  const staleReview = !currentReview && project && lastReview?.id === project.id ? lastReview.review : undefined;
  const reviewSection = <ReviewSection review={currentReview ?? staleReview} stale={!currentReview} script={draft.script} busy={locked}
    onReview={() => void act("正在检查文案", review, true)} onApply={script => void act("", () => applyScript(script))} />;
  const nextStep = (target: number) => { if (target && !draft.script.trim()) setError("请先填写或生成口播文案。"); else { setStep(target); if (target === 2) void loadTakes(); } };

  return <div className="mv-scroll"><div className="mv-studio dp-studio">
    <header className="mv-heading">
      <div><span className="mv-eyebrow">{t("数字主播")}</span><h1>{t("用你的原声，生成真人口播视频。")}</h1><p>{t("以图或以视频生成 · 数字分身原声 · 逐段试听")}</p></div>
      <button disabled={busy} onClick={() => void act("", async () => { if (dirty && draft.script.trim()) await save(); fresh(); })}>{t("开始新视频")}</button>
    </header>
    <details className="mv-library"><summary>{t("我的主播草稿")} · {projects.length}{nextCursor ? "+" : ""}</summary>
      <div className="mv-draft-list">{projects.map(p => <div key={p.id} className="mv-draft-item">
        <button disabled={busy} aria-pressed={p.id === project?.id} onClick={() => void act("", async () => { if (dirty && projectRef.current) await save(); await open(p.id); })}>
          <strong>{p.draft.topic || p.draft.script.slice(0, 40) || t("未命名草稿")}</strong>
          <span>{t(p.draft.mode === "image" ? "以图生成" : "以视频生成")} · {t(statusLabels[p.status] ?? p.status)}</span>
        </button>
        <button className="mv-draft-delete" disabled={busy || ["pending", "running"].includes(p.status)} aria-label={t("删除草稿")} title={t("删除草稿")}
          onClick={() => void confirm({ title: "删除草稿？", message: "删除后草稿、配音和生成的视频都会移除，上传的素材仍保留在个人素材中。", confirm: "删除" }).then(ok => {
            if (ok) void act("", async () => { await presenterApi.remove(p.id); setProjects(old => old.filter(item => item.id !== p.id)); if (projectRef.current?.id === p.id) fresh(); });
          })}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
        </button>
      </div>)}</div>
      {nextCursor && <button className="mv-draft-more" disabled={busy} onClick={() => void act("", async () => {
        const list = await presenterApi.list(nextCursor);
        setProjects(old => [...old, ...list.data.filter(p => !old.some(item => item.id === p.id))]); setNextCursor(list.nextCursor);
      })}>{t("加载更多草稿")}</button>}
    </details>
    {!ready && <p role="status">{t("正在加载草稿…")}</p>}
    {project?.taskId ? <PresenterResult project={project} busy={busy}
      onCancel={() => void act("", async () => { await api.cancelTask(project.taskId!); await open(project.id); })}
      onResume={() => void act("", async () => apply(await presenterApi.resume(project.id)))}
      onRelease={() => void act("", async () => { await presenterApi.release(project.id); apply(await presenterApi.resume(project.id)); })}
      onCopy={() => fresh({ ...draft })}
      onCaptions={captions => void act("", async () => apply(await presenterApi.recompose(project.id, project.version, captions)))} /> : <>
      <nav className="mv-steps" aria-label={t("数字主播创作步骤")}>{STEPS.map((label, i) => <button key={label} disabled={busy} aria-current={i === step ? "step" : undefined} className={i === step ? "active" : ""} onClick={() => nextStep(i)}><span>{i + 1}</span>{t(label)}</button>)}</nav>
      <section className="mv-card"><div className="mv-section-head"><h2>{t(STEPS[step])}</h2><span>{step + 1} / 3</span></div>
        {step === 0 && <ScriptStep form={form} onWrite={() => void act("正在生成口播文案", writeScript, true)}
          reviewPanel={!!draft.script.trim() && reviewSection} />}
        {step === 1 && <PresenterStep form={form} materials={materials} speechAvailable={!!capabilities?.speech}
          onPickTwin={slot => setPicker(slot)} onPickVoice={() => setPicker("voice")} onUpload={(slot, file) => void act("正在上传素材", () => upload(slot, file))} />}
        {step === 2 && <>
          {reviewSection}
          <TakesStep form={form} project={project} takes={takes} blocker={blocker}
            onSynthesize={slots => void act("正在合成配音", () => synthesize(slots))} onGenerate={() => void act("", generate)} />
        </>}
      </section>
      <div className="mv-dock">
        {working && <WaitStatus key={working.started} label={working.label} started={working.started} textRequest={working.textRequest} />}
        {error && <p className="mv-error" role="alert">{t(error)}</p>}
        {notice && <p className="mv-notice" role="status">{t(notice)}</p>}
        <footer className="mv-footer">
          <button disabled={!step || busy} onClick={() => setStep(step - 1)}>{t("上一步")}</button>
          <button disabled={busy || !dirty} onClick={() => void act("", async () => { await save(); setNotice("草稿已保存"); })}>{t("保存草稿")}</button>
          <span role="status">{t(dirty ? "等待保存" : project ? "草稿已保存" : "")}</span>
          <button className="mv-primary" disabled={step === 2 || busy} onClick={() => void act("", async () => { if (dirty && draft.script.trim()) await save(); nextStep(step + 1); })}>{t("下一步")}</button>
        </footer>
      </div>
    </>}
    {project?.taskId && (error || working) && <div className="mv-dock">
      {working && <WaitStatus key={working.started} label={working.label} started={working.started} textRequest={working.textRequest} />}
      {error && <p className="mv-error" role="alert">{t(error)}</p>}
    </div>}
    {confirmDialog}
    {picker === "voice" && <DigitalTwinPicker kind="voice" onClose={() => setPicker(null)} onPickVoice={async item => {
      set("voice", { ...draftRef.current.voice, twinItemId: item.id, voiceName: item.title.slice(0, 255) });
      setPicker(null);
    }} />}
    {(picker === "portrait" || picker === "faceReference") && <DigitalTwinPicker kind="portrait" onClose={() => { if (!exclusive.locked) setPicker(null); }} onSelect={async file => {
      const slot = picker;
      if (exclusive.locked) throw new Error(t("正在处理…"));
      await act("正在上传素材", () => upload(slot, file));
      setPicker(null);
    }} />}
  </div></div>;
}

import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_MARKETING_VIDEO_PROFILE, marketingNarrationSpareSec, marketingReviewText, marketingStoryboardAudioMismatch, resolveMarketingSegments,
  type MarketingDraft, type MarketingProject, type MarketingReview } from "@lot-agent/core/marketing-video";
import { api, ApiClientError, request } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { DigitalTwinPicker } from "../digital-twin/DigitalTwinPanel.js";
import { TextOperationPanel } from "./TextOperationPanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { ReferenceAnalysisPanel } from "./ReferenceAnalysisPanel.js";
import { DraftLibrary, formatBytes, useDraftLibrary } from "./DraftLibrary.js";
import { errorMessage, requestProject, unavailableMessage, type Project } from "./api.js";
import { ResultPanel } from "./ResultPanel.js";
import { CopyStep } from "./CopyStep.js";
import { MaterialsStep } from "./MaterialsStep.js";
import { ProductionStep } from "./ProductionStep.js";
import { NarrationPanel } from "./NarrationPanel.js";
import { KeyArtPanel } from "./KeyArtPanel.js";
import { StoryboardAudioNotice, type DraftForm } from "./StudioFields.js";
import { useDraftSession, useExclusive } from "./session.js";
import { useConfirm } from "./ConfirmDialog.js";
import { WaitStatus } from "./WaitStatus.js";
import { generationBlocker, type StudioCapabilities } from "./production-checks.js";
import { useDraftAutosave, useDraftEditor } from "./useDraftEditor.js";
import { useTextRequests } from "./useTextRequests.js";
import { useProduction } from "./useProduction.js";
import { useStudioMaterials } from "./useStudioMaterials.js";

/** The long request the open draft is waiting on. */
type Wait = { label: string; started: number; textRequest: boolean };
const STEPS = ["确定文案", "确定素材", "确认与制作"];

/** The marketing video studio: the draft library, three creation steps and the made video. The
 * hooks hold the draft (`useDraftEditor`), its text requests (`useTextRequests`), materials
 * (`useStudioMaterials`) and production (`useProduction`); this component opens drafts and lays out the steps. */
export function ProjectStudio({ ownerId = "", onDraftChange }: { ownerId?: string; onDraftChange?: (dirty: boolean) => void }) {
  const { t, locale } = useI18n();
  const generationHintId = useId();
  const storyboardPanel = useRef<HTMLDivElement>(null);
  const session = useDraftSession();
  const exclusive = useExclusive(session);
  const [capabilities, setCapabilities] = useState<StudioCapabilities | null>(null);
  // The server picks the clip model; its limits drive validation and hints here.
  const profile = capabilities?.model ?? DEFAULT_MARKETING_VIDEO_PROFILE;
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState<Wait | null>(null);
  const [twinOpen, setTwinOpen] = useState<"portrait" | "voice" | "narration" | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const library = useDraftLibrary(session, ready, e => setError(errorMessage(e)));
  const [confirmDialog, confirm] = useConfirm();
  const editor = useDraftEditor({ ownerId, session, profile, onEdit: () => { setError(""); setNotice(""); }, onProject: p => library.put(p) });
  const wait = (label: string, textRequest = true) => setWorking({ label, started: Date.now(), textRequest });
  const text = useTextRequests({ editor, session, profile, ownerId, locale, t, confirm, wait, act, setError, setNotice });
  const materials = useStudioMaterials({ editor, session, profile, act, setError });
  const production = useProduction({ editor, text, session, profile, ready, step, setStep, t, confirm, wait, setError, setNotice });
  const navigationBusy = exclusive.busy || text.analysisPending;
  const busy = navigationBusy || text.pending;
  useDraftAutosave(editor, { session, ready, busy, onError: setError, onDraftChange });
  const { draft, project, saving, dirty } = editor;
  const frozen = production.frozen;
  const validReview = !!project?.review && project.reviewedScript === marketingReviewText(draft);
  // The last check of this draft stays visible after edits, so its findings can be fixed one by one.
  const [lastReview, setLastReview] = useState<{ projectId: string; review: MarketingReview } | null>(null);
  useEffect(() => {
    if (validReview && project?.review) setLastReview({ projectId: project.id, review: project.review });
  }, [validReview, project?.id, project?.review]);
  const staleReview = !validReview && project && lastReview?.projectId === project.id ? lastReview.review : undefined;
  const form: DraftForm = { draft, busy, frozen, ready, field: editor.field };

  useEffect(() => {
    if (!frozen && step === 2 && draft.storyboard.length) storyboardPanel.current?.scrollIntoView({ block: "start" });
  }, [draft.storyboard.length, frozen, step]);

  async function open(id: string) {
    const token = session.next();
    text.opening();
    let p: Project;
    // A failed open must not leave the editor locked as if a text request were pending.
    try { p = await requestProject(`/marketing-videos/${id}`); }
    catch (e) { if (session.current(token)) text.unlock(); throw e; }
    if (!session.current(token)) return;
    editor.draftId.current = id;
    text.opened(p);
    editor.load(p); materials.setMaterials(p.assets ?? {});
    setStep(p.referenceAnalysis ? 0 : p.draft.storyboard.length ? 2 : 0);
    editor.remember(id);
  }
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    setReady(false); setLoadError("");
    void Promise.all([
      request<{ data: Project[]; nextCursor?: string }>("/marketing-videos?limit=20", { signal: controller.signal }),
      request<StudioCapabilities>("/marketing-videos/capabilities", { signal: controller.signal }),
    ]).then(async ([list, caps]) => {
      if (stopped) return;
      library.showFirstPage(list); setCapabilities(caps);
      let id: string | null = null;
      try { id = localStorage.getItem(editor.storageKey); } catch { /* Optional preference. */ }
      // The remembered draft may be older than the first page.
      if (id) {
        try { await open(id); }
        catch (e) {
          if (e instanceof ApiClientError && e.status === 404 && !/^(404\s+)?Not Found$/i.test(e.message)) editor.remember(null);
          else if (!stopped) setError(errorMessage(e));
        }
      }
      if (!stopped) setReady(true);
    }).catch(e => {
      if (!stopped) setLoadError(e instanceof ApiClientError && e.status === 404 ? unavailableMessage : "营销视频服务暂时无法连接，请重试。");
    }).finally(() => clearTimeout(timeout));
    return () => { stopped = true; session.next(); clearTimeout(timeout); controller.abort(); text.abortUpload(); };
  }, [editor.storageKey, loadAttempt]);

  /** Run one user action at a time. Text actions wait while a text request is pending; navigation does not. */
  async function act(work: () => Promise<void>, navigation = false) {
    if (exclusive.locked || text.analysisPending || (!navigation && text.pending) || !ready) return;
    await exclusive.run(async () => {
      setError("");
      try { await work(); } catch (e) { if (session.alive) setError(errorMessage(e)); }
      finally { if (session.alive) setWorking(null); }
    });
  }
  /** A fix only changes the draft; autosave stores it and the user checks again when ready. */
  function applyReviewEdit(next: MarketingDraft) {
    if (!busy && ready) editor.update(next);
  }
  async function newDraft(copy = false, target = 0) {
    text.release();
    if (dirty) await editor.save();
    resetDraft(copy, target);
  }
  function resetDraft(copy = false, target = 0) {
    session.next();
    const next = editor.reset(copy);
    text.reset(next);
    if (!copy) materials.setMaterials({});
    setStep(target);
  }
  async function deleteDraft(p: MarketingProject) {
    const message = "确定删除视频草稿“{0}”吗？草稿、已生成的视频和片段、参考视频分析将一起永久删除，无法恢复。如需保留成片，请先下载。\n上传的素材仍保留在「个人素材」中。";
    if (!await confirm({ title: "删除视频草稿", message, values: [p.draft.publishTitle || p.draft.topic || t("未命名草稿")], confirm: "删除" })) return;
    await act(async () => {
      // Let an in-flight autosave settle so it cannot recreate the deleted row.
      if (editor.flight.current) await editor.flight.current.catch(() => {});
      const removed = await request<{ removedBytes: number; keptAnalyses: number }>(`/marketing-videos/${p.id}`, { method: "DELETE" });
      if (!session.alive) return;
      library.remove(p.id); library.refreshUsage();
      if (p.id === editor.draftId.current) { text.release(); resetDraft(); }
      // The notice is shown through t(); already translated text passes through unchanged.
      setNotice([removed.removedBytes ? t("草稿已删除，释放 {0}。", [formatBytes(removed.removedBytes)]) : t("草稿已删除。"),
        t("上传的素材仍在「个人素材」中。"),
        ...(removed.keptAnalyses ? [t("{0} 条参考分析的模型请求结果待核实，暂未删除。", [removed.keptAnalyses])] : [])].join(locale === "zh" ? "" : " "));
    });
  }

  const plan = (() => {
    try { return { parts: resolveMarketingSegments(draft, profile), error: "" }; }
    catch (e) { return { parts: [], error: errorMessage(e) }; }
  })();
  const sameSource = project?.draft.copyMode === draft.copyMode && project.draft.reference === draft.reference
    && project.draft.referenceUpload?.id === draft.referenceUpload?.id;
  const referenceAnalysis = sameSource ? project.referenceAnalysis : undefined;
  const copyReady = draft.copyMode === "rewrite" ? text.sourceKind === "upload" ? !!draft.referenceUpload : !!draft.reference.trim() : !!draft.topic.trim();
  const copyLabel = busy && !text.unknown ? "正在处理…" : draft.copyMode === "rewrite" ? "一键拆解并生成" : "生成文案和分镜";
  const copyAction = <button className="mv-soft" disabled={busy || !copyReady || !ready} onClick={() => void act(() => text.writeCopy(open))}>{t(copyLabel)}</button>;
  const referenceVideoStatus = profile.imagesWithReferenceVideo
    ? t("已选择参考视频：参考图片合计最多 {0} 张；不生成口播配音，音色设置不生效，可添加背景音乐。", [profile.imagesWithReferenceVideo])
    : t("已选择参考视频：参考图片不参与生成；不生成口播配音，音色设置不生效，可添加背景音乐。");
  const blocker = generationBlocker({ ready, loadError, draft, profile, capabilities, materials: materials.materials, planError: plan.error,
    narration: production.currentNarration });
  const nextStep = (target: number) => { if (target && !draft.script.trim()) setError("请先填写或生成视频文案。"); else setStep(target); };

  const audioNotice = marketingStoryboardAudioMismatch(draft) && !frozen && <StoryboardAudioNotice video={!!draft.assets.video} busy={busy || !ready}
    onRebuild={text.rebuildStoryboard} onKeep={text.keepStoryboard} />;
  const reviewSection = !!draft.script.trim() && <section className="mv-review-section" aria-label={t("文案与分镜检查")}>
    <div className="mv-section-head"><h3>{t("文案与分镜检查")}</h3><button disabled={busy || !ready} onClick={() => void act(text.review)}
      title={t("依据风险词规则表及抖音、小红书社区规则，检查文案、台词、标题标签和分镜内容。")}>{t("检查当前文案")}</button></div>
    {validReview
      ? <ReviewPanel key={project!.reviewedScript} review={project!.review!} draft={draft} busy={busy} onApply={applyReviewEdit} />
      : staleReview ? <ReviewPanel key="stale" stale review={staleReview} draft={draft} busy={busy} onApply={applyReviewEdit} />
      : <p className="mv-hint" role="status">{t("尚未检查，生成视频前会自动检查。")}</p>}
  </section>;
  // Errors and progress stay next to the step buttons instead of the end of a long page.
  const status = <>
    {project && <TextOperationPanel key={project.id} projectId={project.id} reload={text.reload} showRunning={!working?.textRequest}
      onState={async operation => { if (project.id === editor.draftId.current) await text.operationState(operation); }} retry={text.retry} />}
    {working && <WaitStatus key={working.started} label={working.label} started={working.started} textRequest={working.textRequest} />}
    {error && <p className="mv-error" role="alert">{t(error)}</p>}
    {!project?.taskId && notice && <p className="mv-notice" role="status">{t(notice)}</p>}
  </>;
  const copyText = async () => {
    await editor.save();
    await navigator.clipboard.writeText([draft.publishTitle, draft.tags].filter(Boolean).join("\n"));
    setNotice("已复制");
  };
  const keyArtPanel = production.keyArtIssue !== "video" && <KeyArtPanel keyArt={production.currentKeyArt} full={production.keyArtIssue === "full"}
    total={profile.referenceImages.total} busy={busy || !ready} onGenerate={redo => void act(() => production.makeKeyArt(redo))} />;
  const narrationClips = production.currentNarration;
  const narrationPanel = production.voiceover && draft.narration?.twinItemId && <NarrationPanel projectId={project?.id} shots={draft.storyboard}
    clips={narrationClips} busy={busy || !ready}
    spareSec={narrationClips ? marketingNarrationSpareSec(draft.storyboard, draft, profile, narrationClips.map(clip => clip.durationMs)) : 0}
    onSynthesize={slots => void act(() => production.synthesizeNarration(slots))} onFit={production.fitNarration} />;
  const generateLabel = busy && !text.unknown ? saving ? "正在保存…" : "正在处理…" : draft.storyboard.length ? "确认分镜并生成视频" : "生成分镜并预览";

  return <div className="mv-scroll"><div className="mv-studio">
    <header className="mv-heading">
      <div><span className="mv-eyebrow">{t("营销影像")}</span><h1>{t("三步，把卖点变成视频。")}</h1><p>{t("15–60 秒 · 自动分镜合成 · 抖音发布素材")}</p></div>
      <button disabled={navigationBusy || saving || !ready} onClick={() => void act(() => newDraft(), true)}>{t("开始新视频")}</button>
    </header>
    {loadError && <div className="mv-connection-error" role="alert"><p>{t(loadError)}</p>
      <button onClick={() => { setLoadError(""); setLoadAttempt(value => value + 1); }}>{t("重新连接")}</button></div>}
    <DraftLibrary projects={library.projects} nextCursor={library.nextCursor} query={library.query} currentId={project?.id}
      openBusy={navigationBusy || saving} moreBusy={navigationBusy} deleteBusy={busy || saving}
      onQuery={library.setQuery} onDelete={p => void deleteDraft(p)} onMore={() => void act(library.loadMore, true)} usage={library.usage} onShow={library.refreshUsage}
      onOpen={p => void act(async () => { if (dirty) await editor.save(); await open(p.id); }, true)} />
    {!ready && !loadError && <p role="status">{t("正在加载草稿…")}</p>}
    {project?.taskId ? <ResultPanel form={form} project={project} saving={saving} dirty={dirty} knowledge={!!capabilities?.knowledge} notice={notice}
      reviewPanel={reviewSection} handlers={materials.handlers} onPickNarrationVoice={() => setTwinOpen("narration")}
      onCopyDraft={target => void act(() => newDraft(true, target))}
      onResume={() => void act(() => production.generate(true))}
      onCancel={() => void act(async () => { await api.cancelTask(project.taskId!); await open(project.id); })}
      onRelease={() => void act(() => production.releaseUnknown(project.id))}
      onPublication={() => void act(() => text.publication())}
      onCopyText={() => void act(copyText)}
      onArchive={() => void act(production.archive)}
      onShots={editor.setShots} onRevertShots={production.revertShots} onRevise={shots => void act(() => production.revise(shots))} /> : <>
      <nav className="mv-steps" aria-label={t("视频创作步骤")}>{STEPS.map((label, i) => <button key={label} disabled={busy || !ready}
        aria-current={i === step ? "step" : undefined} className={i === step ? "active" : ""} onClick={() => nextStep(i)}><span>{i + 1}</span>{t(label)}</button>)}</nav>
      <section className="mv-card"><div className="mv-section-head"><h2>{t(STEPS[step])}</h2><span>{step + 1} / 3</span></div>
        {step === 0 && <CopyStep form={form} inputId={`${generationHintId}-reference`} sourceKind={text.sourceKind} uploading={text.uploadingReference}
          analysis={text.analysis} planError={plan.error}
          analysisPanel={referenceAnalysis
            ? <ReferenceAnalysisPanel key={`${ownerId}:${referenceAnalysis.id}`} id={referenceAnalysis.id} ownerId={ownerId} onActive={text.setAnalysisPending}
              onComplete={text.completedAnalysis} completedAction={copyAction} disabled={exclusive.busy || text.pending || saving || !ready} />
            : copyAction}
          onUploadSource={text.chooseReferenceSource} onReferenceFile={file => void act(() => text.selectReferenceVideo(file))}
          onStoryboard={editor.setShots} onStoryboardAi={text.aiStoryboard} onPublication={() => void act(() => text.publication())} />}
        {step === 1 && <MaterialsStep form={form} profile={profile} handlers={materials.handlers} referenceVideoStatus={referenceVideoStatus}
          onPickPortrait={() => setTwinOpen("portrait")} audioNotice={audioNotice} />}
        {step === 2 && <ProductionStep form={form} profile={profile} handlers={materials.handlers} referenceVideoStatus={referenceVideoStatus}
          parts={plan.parts} planError={plan.error} blocker={blocker} blockerId={generationHintId} storyboardPanel={storyboardPanel} audioNotice={audioNotice}
          narrationAvailable={!!capabilities?.narration} onPickNarrationVoice={() => setTwinOpen("narration")}
          keyArtPanel={keyArtPanel} narrationPanel={narrationPanel} reviewPanel={reviewSection} buttonLabel={generateLabel}
          onPickVoice={() => setTwinOpen("voice")} onStoryboard={editor.setShots} onStoryboardAi={text.aiStoryboard} onEditCopy={() => setStep(0)}
          onGenerate={() => void act(() => draft.storyboard.length ? production.generate() : text.editStoryboard())}
          onManualStoryboard={() => void act(text.manualStoryboard)} />}
      </section>
      <div className="mv-dock">
      {status}
      <footer className="mv-footer">
        <button disabled={!step || busy || !ready} onClick={() => setStep(step - 1)}>{t("上一步")}</button>
        <button disabled={busy || saving || !ready || !dirty} onClick={() => void act(async () => { await editor.save(); })}>{t("保存草稿")}</button>
        <span role="status">{t(saving ? "正在保存…" : dirty ? "等待保存" : project ? "草稿已保存" : "")}</span>
        <button className="mv-primary" disabled={step === 2 || busy || !ready} onClick={() => nextStep(step + 1)}>{t("下一步")}</button>
      </footer>
      </div>
    </>}
    {project?.taskId && <div className="mv-dock">{status}</div>}
    {confirmDialog}
    {twinOpen === "narration" && <DigitalTwinPicker kind="voice" onClose={() => setTwinOpen(null)} onPickVoice={async item => {
      const current = editor.draftRef.current.narration;
      if (current) editor.field("narration", { ...current, twinItemId: item.id, voiceName: item.title.slice(0, 255) });
      setTwinOpen(null);
    }} />}
    {twinOpen && twinOpen !== "narration" && <DigitalTwinPicker kind={twinOpen} onClose={() => { if (!exclusive.locked) setTwinOpen(null); }} onSelect={async (file, kind) => {
      if (exclusive.locked) throw new Error(t("正在处理…"));
      await exclusive.run(() => materials.selectMaterial(file, kind === "voice" ? "voice" : "portrait"));
    }} />}
  </div></div>;
}

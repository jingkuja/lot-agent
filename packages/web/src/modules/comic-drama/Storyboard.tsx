import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  adaptComicClipDraftForModel, checkComicClipIssues, COMIC_VIDEO_SAFE_COMMON_LIMITS, comicVideoDurationSupported,
  comicVideoProfile, countComicClipFoldedReferences, isComicClipDraftBlank, rebalanceShotDurationShares,
  resolveComicVideoAudioMode,
  type ComicClipCheckIssue, type ComicClipCasting, type ComicDirectorProposal, type ComicDramaClip,
  type ComicDramaClipDraft, type ComicDramaSeries, type ComicLibraryPage, type ComicMaterial, type ComicMaterialImageKind,
  type ComicMaterialKind, type ComicMaterialRef, type ComicMedia, type ComicSeriesCast, type ComicShotSfxPosition, type ComicShotSfxRef,
  type ComicVideoAudioMode, type ComicVideoMaterialRef, type ComicVideoProfile,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { describeComicClipCheckIssue } from "./clip-check-copy.js";
import { ComicClipOriginBadge } from "./ComicHierarchyBar.js";
import { SparklesIcon } from "./ComicStudioIcons.js";
import { comicGenerationApi } from "./generation-api.js";
import { ComicTakeStatus, hasActiveComicTakes, ImageTakeActions, useGenerationHistory } from "./GenerationHistory.js";
import { comicLibraryApi } from "./library-api.js";
import { DictionaryOptions, MediaPreview, useComicChoices } from "./LibraryParts.js";
import { MaterialImageGeneration } from "./MaterialImageGeneration.js";

const videoInputLabels = { image: "参考图", audio: "参考音频", video: "参考视频", last_frame: "尾帧" } as const;

type Props = {
  dramaTitle?: string;
  series?: Pick<ComicDramaSeries, "videoModel"> & Partial<Pick<ComicDramaSeries, "styleKey" | "title" | "seriesGroup" | "episodeNo">>;
  clips: readonly ComicDramaClip[];
  cast: readonly ComicSeriesCast[];
  drafts: Readonly<Record<string, { draft: ComicDramaClipDraft }>>;
  disabled: boolean;
  locked: boolean;
  selected: string | null;
  select: (id: string) => void;
  edit: (id: string, draft: ComicDramaClipDraft) => void;
  add: (afterClipId?: string) => void;
  copy: (id: string) => void;
  remove: (id: string) => void;
  reorder: (ids: string[]) => void;
  onEnhanceClip?: (id: string) => void;
  hasScript?: boolean;
  scriptCharCount?: number;
  breakdownBusy?: boolean;
  breakdownError?: string | null;
  breakdownNotice?: string | null;
  breakdownProposal?: ComicDirectorProposal | null;
  onGenerateFromScript?: () => void;
  onCancelBreakdown?: () => void;
  onDismissBreakdownError?: () => void;
  onDismissBreakdownNotice?: () => void;
  onApplyBreakdownPreview?: (decision: "append" | "replace") => void;
  onDismissBreakdownPreview?: () => void;
  onGoScript?: () => void;
};

function clipProgressLabel(clip: ComicDramaClip): { stage: string; tone: string } {
  const p = clip.progress;
  if (!p) return { stage: "草稿", tone: "idle" };
  if (p.videoState === "running" || p.videoState === "pending" || p.keyframeState === "running" || p.keyframeState === "pending") {
    return { stage: "生成中", tone: "busy" };
  }
  if (p.adoptedVideoTakeId) return { stage: "已采用成片", tone: "done" };
  if (p.videoState === "ready") return { stage: "待采用视频", tone: "ready" };
  if (p.keyframeApproved) return { stage: "首帧已确认", tone: "frame" };
  if (p.keyframeState === "ready") return { stage: "待确认首帧", tone: "frame" };
  if (p.videoState === "failed" || p.keyframeState === "failed" || p.videoState === "unknown" || p.keyframeState === "unknown") {
    return { stage: "需处理", tone: "warn" };
  }
  return { stage: "草稿", tone: "idle" };
}

export function Storyboard({
  dramaTitle, series, clips, cast, drafts, disabled, locked, selected, select, edit, add, copy, remove, reorder, onEnhanceClip,
  hasScript = false, scriptCharCount = 0, breakdownBusy = false, breakdownError = null, breakdownNotice = null,
  breakdownProposal = null, onGenerateFromScript, onCancelBreakdown, onDismissBreakdownError,
  onDismissBreakdownNotice, onApplyBreakdownPreview, onDismissBreakdownPreview, onGoScript,
}: Props) {
  const { t } = useI18n();
  const dragging = useRef<string | null>(null);
  const resolvedDramaTitle = dramaTitle ?? series?.seriesGroup ?? series?.title ?? "";
  const resolvedEpisodeNo = series?.episodeNo ?? 1;
  const resolvedEpisodeTitle = series?.title ?? "";
  const clip = clips.find(entry => entry.id === selected) ?? clips[0];
  const activeDraft = clip ? (drafts[clip.id]?.draft ?? clip.draft) : null;
  const allClipsBlank = clips.length > 0
    && clips.every(item => isComicClipDraftBlank(drafts[item.id]?.draft ?? item.draft));
  const previewClips = breakdownProposal?.proposal?.clips ?? null;
  const clipIssues = clip && activeDraft
    ? checkComicClipIssues({ videoModel: series?.videoModel ?? null }, { ...clip, draft: activeDraft }, cast)
    : [];
  const adaptedPreview = clip && activeDraft && series?.videoModel
    ? adaptComicClipDraftForModel(activeDraft, series.videoModel)
    : null;
  const move = (id: string, to: number) => {
    const from = clips.findIndex(item => item.id === id);
    if (disabled || from < 0 || to < 0 || to >= clips.length || from === to) return;
    const ids = clips.map(item => item.id);
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    reorder(ids);
  };
  return <div className="comic-board">
    <section className="comic-strip" aria-label={t("分镜列表")}>
      {resolvedDramaTitle && (
        <div className="comic-strip-head">
          <small>{resolvedDramaTitle} · {t("第 {0} 集", [resolvedEpisodeNo])}</small>
          <small>{t("共 {0} 个分镜", [clips.length])}</small>
        </div>
      )}
      {clips.length === 0 && <p>{t("还没有分镜")}</p>}
      {clips.map((item, index) => {
        const badge = clipProgressLabel(item);
        const itemDraft = drafts[item.id]?.draft ?? item.draft;
        const itemIssues = checkComicClipIssues({ videoModel: series?.videoModel ?? null }, { ...item, draft: itemDraft }, cast);
        return <div key={item.id} className={item.id === clip?.id ? "comic-cut selected" : "comic-cut"}
          draggable={!disabled} onDragStart={event => {
            dragging.current = item.id;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", item.id);
          }} onDragEnd={() => { dragging.current = null; }}
          onDragOver={event => { if (!disabled && dragging.current) event.preventDefault(); }}
          onDrop={event => { event.preventDefault(); if (dragging.current) move(dragging.current, index); dragging.current = null; }}>
          <button type="button" aria-pressed={item.id === clip?.id} onClick={() => select(item.id)}>
            <span className="comic-cut-number">{String(item.ordinal).padStart(2, "0")}</span>
            <span className="comic-cut-body">
              <span className="comic-cut-title">{itemDraft.scene || t("未命名分镜")}</span>
              <span className="comic-cut-badges">
                <small className="comic-pill" data-tone={badge.tone}>{t(badge.stage)}</small>
                {item.progress?.adoptedVideoVersion != null && (
                  <small className="comic-pill" data-tone="done">{t("采用 v{0}", [item.progress.adoptedVideoVersion])}</small>
                )}
                {itemIssues.length > 0 && <ClipIssuePill ordinal={item.ordinal} issues={itemIssues} selected={item.id === clip?.id} />}
              </span>
            </span>
          </button>
        </div>;
      })}
      {onGenerateFromScript && !locked && (
        <button
          type="button"
          className="comic-ai-button comic-strip-ai-btn"
          disabled={disabled || breakdownBusy || !hasScript}
          onClick={onGenerateFromScript}
        >
          <SparklesIcon size={14} />
          <span>{t(breakdownBusy ? "AI 拆分中…" : "AI 从剧本生成分镜")}</span>
        </button>
      )}
      <button type="button" className="comic-add" disabled={disabled} onClick={() => add()}>＋ {t("添加分镜")}</button>
    </section>
    <div className="comic-storyboard-main">
      {breakdownBusy && (
        <div className="comic-storyboard-ai-banner" role="status">
          <div className="comic-storyboard-ai-copy">
            <strong><SparklesIcon size={15} /> {t("AI 正在根据本集剧本与选角自动拆分分镜…")}</strong>
            <small>{t("正在解析场景、镜头景别运镜、人物对白与绑定出镜角色，请稍候。")}</small>
          </div>
          {onCancelBreakdown && (
            <button type="button" onClick={onCancelBreakdown}>{t("取消")}</button>
          )}
        </div>
      )}
      {breakdownError && (
        <div className="comic-error" role="alert">
          <span>{breakdownError}</span>
          <div className="comic-actions">
            {onGenerateFromScript && hasScript && !locked && (
              <button type="button" disabled={disabled || breakdownBusy} onClick={onGenerateFromScript}>{t("重试")}</button>
            )}
            {onDismissBreakdownError && (
              <button type="button" onClick={onDismissBreakdownError}>{t("关闭")}</button>
            )}
          </div>
        </div>
      )}
      {breakdownNotice && (
        <div className="comic-generation-note" role="status">
          <span>{breakdownNotice}</span>
          {onDismissBreakdownNotice && (
            <button type="button" onClick={onDismissBreakdownNotice}>{t("知道了")}</button>
          )}
        </div>
      )}
      {previewClips && previewClips.length > 0 && (
        <section className="comic-ai-preview comic-breakdown-preview" aria-label={t("AI 分镜拆分建议")}>
          <header>
            <strong>{t("AI 已生成 {0} 个分镜建议（当前已有分镜，请选择应用方式）", [previewClips.length])}</strong>
          </header>
          <ol className="comic-breakdown-preview-list">
            {previewClips.map((item, idx) => {
              const matchedNames = (item.cast ?? [])
                .map(c => cast.find(entry => entry.snapshot.characterId === c.characterId)?.snapshot.name)
                .filter(Boolean);
              return (
                <li key={idx}>
                  <strong>
                    {t("分镜 {0}", [idx + 1])} · {item.scene || t("未命名分镜")} · {t("{0} 秒", [item.durationMs / 1000])}
                  </strong>
                  {matchedNames.length > 0 && (
                    <small>{t("出镜角色")}：{matchedNames.join(" / ")}</small>
                  )}
                  <small>
                    {item.shots.map(s => s.description).join("；")}
                  </small>
                  {item.lines.length > 0 && (
                    <small>
                      {item.lines.map(l => (l.speaker ? `${l.speaker}：${l.text}` : l.text)).join(" / ")}
                    </small>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="comic-actions">
            {onApplyBreakdownPreview && (
              <>
                <button type="button" className="primary" disabled={disabled} onClick={() => onApplyBreakdownPreview("replace")}>
                  {t("替换现有分镜")}
                </button>
                <button type="button" disabled={disabled} onClick={() => onApplyBreakdownPreview("append")}>
                  {t("追加到末尾")}
                </button>
              </>
            )}
            {onDismissBreakdownPreview && (
              <button type="button" disabled={disabled} onClick={onDismissBreakdownPreview}>{t("放弃")}</button>
            )}
          </div>
        </section>
      )}
      {clips.length === 0 ? (
        <section className="comic-edit-card comic-storyboard-empty">
          {hasScript ? (
            <>
              <h2>{t("从本集剧本一键生成分镜")}</h2>
              <p>
                {t("本集已准备 {0} 字剧本与 {1} 名选角，可直接由 AI 自动拆分为含场景、镜头描述、对白与出镜角色的分镜表，生成后只需微调即可。", [
                  scriptCharCount,
                  cast.length,
                ])}
              </p>
              <div className="comic-actions">
                {onGenerateFromScript && !locked && (
                  <button
                    type="button"
                    className="primary comic-ai-button"
                    disabled={disabled || breakdownBusy}
                    onClick={onGenerateFromScript}
                  >
                    <SparklesIcon size={15} />
                    <span>{t("AI 从本集剧本生成分镜")}</span>
                  </button>
                )}
                {!locked && (
                  <button type="button" disabled={disabled} onClick={() => add()}>＋ {t("手动添加分镜")}</button>
                )}
              </div>
            </>
          ) : (
            <>
              <h2>{t("还没有分镜")}</h2>
              <p>{t("先在「本集剧本」填写或代入剧本内容，即可由 AI 一键生成分镜；也可以手动添加空白分镜。")}</p>
              <div className="comic-actions">
                {onGoScript && (
                  <button type="button" className="primary" onClick={onGoScript}>{t("去填写本集剧本")}</button>
                )}
                {!locked && (
                  <button type="button" disabled={disabled} onClick={() => add()}>＋ {t("添加分镜")}</button>
                )}
              </div>
            </>
          )}
        </section>
      ) : (
        <>
          {allClipsBlank && hasScript && onGenerateFromScript && !locked && !breakdownBusy && !previewClips && (
            <div className="comic-storyboard-ai-banner" role="region" aria-label={t("AI 自动填充空白分镜")}>
              <div className="comic-storyboard-ai-copy">
                <strong><SparklesIcon size={15} /> {t("检测到本集已有剧本与选角，当前分镜尚未填写")}</strong>
                <small>{t("可由 AI 直接根据本集剧本拆出全部场景、镜头、台词并自动绑定出镜角色，省去逐格手动输入。")}</small>
              </div>
              <button
                type="button"
                className="primary comic-ai-button"
                disabled={disabled}
                onClick={onGenerateFromScript}
              >
                <SparklesIcon size={14} />
                <span>{t("AI 一键带入剧本生成分镜")}</span>
              </button>
            </div>
          )}
          {clip && activeDraft && <section className="comic-edit-card">
            <header>
              <div>
                {resolvedDramaTitle && (
                  <ComicClipOriginBadge
                    dramaTitle={resolvedDramaTitle}
                    episodeNo={resolvedEpisodeNo}
                    episodeTitle={resolvedEpisodeTitle || resolvedDramaTitle}
                    clipOrdinal={clip.ordinal}
                    totalClips={clips.length}
                  />
                )}
                <h2>{t("分镜 {0}", [clip.ordinal])}</h2>
                <div className="comic-cut-badges">
                  <small className="comic-pill" data-tone={clipProgressLabel(clip).tone}>{t("制作进度")} · {t(clipProgressLabel(clip).stage)}</small>
                  <small className="comic-pill" data-tone={clip.progress?.adoptedVideoVersion ? "done" : "idle"}>
                    {t("当前采用版")} · {clip.progress?.adoptedVideoVersion != null ? t("版本 {0}", [clip.progress.adoptedVideoVersion]) : t("未采用")}
                  </small>
                </div>
              </div>
              <div className="comic-actions">
                {onEnhanceClip && <button type="button" disabled={disabled} onClick={() => onEnhanceClip(clip.id)}>{t("AI 增强")}</button>}
                <button type="button" disabled={disabled || clip.ordinal === 1} onClick={() => move(clip.id, clip.ordinal - 2)}>{t("上移")}</button>
                <button type="button" disabled={disabled || clip.ordinal === clips.length} onClick={() => move(clip.id, clip.ordinal)}>{t("下移")}</button>
                <button type="button" disabled={disabled} onClick={() => add(clip.id)}>{t("在后面插入")}</button>
                <button type="button" disabled={disabled} onClick={() => copy(clip.id)}>{t("复制分镜")}</button>
                <button type="button" disabled={disabled} onClick={() => remove(clip.id)}>{t("删除")}</button>
              </div>
            </header>
            {clipIssues.length > 0 && <ClipIssueBanner issues={clipIssues} cast={cast} disabled={locked}
              onAdapt={adaptedPreview?.changed ? () => edit(clip.id, adaptedPreview.draft) : undefined}
              addCast={characterId => {
                const member = cast.find(entry => entry.snapshot.characterId === characterId);
                if (!member || (activeDraft.cast ?? []).some(a => a.characterId === characterId)) return;
                const slot = member.snapshot.assets.find(asset => asset.kind === "slot" && asset.key === "front")
                  ?? member.snapshot.assets.find(asset => asset.kind === "slot");
                edit(clip.id, { ...activeDraft, cast: [...(activeDraft.cast ?? []), { characterId, slotKey: slot?.key ?? null, expressionKey: null }] });
              }} />}
            <ClipFields key={clip.id} draft={activeDraft} disabled={locked} cast={cast} profile={comicVideoProfile(series?.videoModel ?? null)}
              generateDisabled={disabled} styleKey={series?.styleKey} change={draft => edit(clip.id, draft)} />
          </section>}
        </>
      )}
    </div>
  </div>;
}

function ClipIssuePill({ ordinal, issues, selected }: {
  ordinal: number;
  issues: readonly ComicClipCheckIssue[];
  selected: boolean;
}) {
  const { t } = useI18n();
  const tooltipId = useId();
  const triggerRef = useRef<HTMLElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 12, top: 12 });

  const clearClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const updatePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el || typeof window === "undefined") return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const maxW = Math.min(340, Math.max(200, vw - 24));
    const left = Math.max(12, Math.min(rect.left, vw - maxW - 12));
    const placeAbove = vh - rect.bottom < 220 && rect.top > 220;
    setPos(placeAbove ? { left, bottom: Math.max(12, vh - rect.top + 8) } : { left, top: Math.max(12, rect.bottom + 8) });
  }, []);
  const openPopover = () => {
    clearClose();
    updatePos();
    setOpen(true);
  };
  const scheduleClose = () => {
    clearClose();
    closeTimerRef.current = setTimeout(() => setOpen(false), 120);
  };

  useEffect(() => () => clearClose(), []);
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const closeNow = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeNow(); };
    window.addEventListener("scroll", closeNow, true);
    window.addEventListener("resize", closeNow);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", closeNow, true);
      window.removeEventListener("resize", closeNow);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return <>
    <small
      ref={triggerRef}
      className="comic-pill comic-pill-trigger"
      data-tone="warn"
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={openPopover}
      onMouseLeave={scheduleClose}
    >
      {t("{0} 项提醒", [issues.length])}
    </small>
    {open && typeof document !== "undefined" && createPortal(
      <div
        id={tooltipId}
        role="tooltip"
        className="comic-issue-popover"
        style={{
          left: `${pos.left}px`,
          ...(pos.top !== undefined ? { top: `${pos.top}px` } : { bottom: `${pos.bottom ?? 12}px` }),
        }}
        onMouseEnter={clearClose}
        onMouseLeave={scheduleClose}
      >
        <strong>{t("分镜 {0} · {1} 项提醒", [ordinal, issues.length])}</strong>
        <ul>
          {issues.map((issue, idx) => <li key={idx}>{describeComicClipCheckIssue(issue, t)}</li>)}
        </ul>
        {!selected && <small className="comic-issue-popover-hint">{t("点击分镜卡查看并处理")}</small>}
      </div>,
      document.body,
    )}
  </>;
}

function ClipIssueBanner({ issues, cast, disabled, addCast, onAdapt }: {
  issues: ComicClipCheckIssue[]; cast: readonly ComicSeriesCast[]; disabled: boolean;
  addCast: (characterId: string) => void; onAdapt?: () => void;
}) {
  const { t } = useI18n();
  return <div className="comic-issue-banner" role="status">
    <div className="comic-actions">
      <strong>{t("分镜查漏提醒")}</strong>
      {!disabled && onAdapt && (
        <button type="button" onClick={onAdapt}>{t("一键兼容当前模型")}</button>
      )}
    </div>
    <ul>{issues.map((issue, idx) => (
      <li key={idx}>
        <span>{describeComicClipCheckIssue(issue, t)}</span>
        {issue.code === "SPEAKER_NOT_IN_CAST" && !disabled && issue.suggestedCharacterId
          && cast.some(c => c.snapshot.characterId === issue.suggestedCharacterId) && (
          <button type="button" onClick={() => addCast(issue.suggestedCharacterId!)}>{t("一键加入出镜")}</button>
        )}
      </li>
    ))}</ul>
  </div>;
}

function ClipFields({ draft, disabled, generateDisabled, cast, profile, styleKey, change }: {
  draft: ComicDramaClipDraft; disabled: boolean; cast: readonly ComicSeriesCast[]; change: (draft: ComicDramaClipDraft) => void;
  generateDisabled: boolean; profile?: ComicVideoProfile; styleKey?: string;
}) {
  const { t } = useI18n();
  const framing = useComicChoices("framing");
  const movement = useComicChoices("movement");
  const emotions = useComicChoices("emotion");
  const [picker, setPicker] = useState<{ kind: "scene" | "prop" | "sound"; shotIndex?: number } | null>(null);
  const [generating, setGenerating] = useState<ComicMaterialImageKind | null>(null);
  const [imageTask, setImageTask] = useState<{ kind: ComicMaterialImageKind; name: string; id: string } | null>(null);
  const firstFraming = framing.find(entry => !entry.inactive)?.key;
  const firstMovement = movement.find(entry => !entry.inactive)?.key;
  const update = (values: Partial<ComicDramaClipDraft>) => change({ ...draft, ...values });
  const updateShot = (index: number, values: Partial<ComicDramaClipDraft["shots"][number]>) =>
    update({ shots: draft.shots.map((shot, i) => i === index ? { ...shot, ...values } : shot) });
  const updateLine = (index: number, values: Partial<ComicDramaClipDraft["lines"][number]>) =>
    update({ lines: draft.lines.map((line, i) => i === index ? { ...line, ...values } : line) });
  const setShots = (shots: ComicDramaClipDraft["shots"]) => {
    if (!shots.length) return;
    const share = Math.floor(100 / shots.length);
    update({ shots: shots.map((shot, i) => ({ ...shot, durationShare: i === shots.length - 1 ? 100 - share * i : share })) });
  };
  const bindMaterial = (target: { kind: "scene" | "prop" | "sound"; shotIndex?: number }, ref: ComicMaterialRef) => {
    if (target.kind === "scene") {
      update({ sceneRef: ref });
    } else if (target.kind === "prop") {
      const current = draft.propRefs ?? [];
      const index = current.findIndex(item => item.materialId === ref.materialId);
      if (index >= 0 || current.length < 10) {
        update({ propRefs: index >= 0 ? current.map((item, i) => i === index ? ref : item) : [...current, ref] });
      }
    } else if (typeof target.shotIndex === "number") {
      const shot = draft.shots[target.shotIndex];
      if (shot) {
        const current = shot.sfxRefs ?? [];
        if (current.length < 5) {
          const nextRef: ComicShotSfxRef = { ...ref, position: "start" };
          updateShot(target.shotIndex, { sfxRefs: [...current, nextRef] });
        }
      }
    } else {
      const current = draft.sfxRefs ?? [];
      if (!current.some(item => item.mediaId === ref.mediaId) && current.length < 10) {
        update({ sfxRefs: [...current, ref] });
      }
    }
    setPicker(null);
  };
  const pickMaterial = (target: { kind: "scene" | "prop" | "sound"; shotIndex?: number }, material: ComicMaterial) =>
    bindMaterial(target, { materialId: material.id, mediaId: material.media.id, name: material.name });
  const castNames = cast.map(entry => entry.snapshot.name);
  return <fieldset disabled={disabled} className="comic-clip-fields">
    <div className="comic-fields">
      <label>{t("场景")}<input maxLength={1000} value={draft.scene} onChange={event => update({ scene: event.target.value })} /></label>
      <label>{t("时长（秒）")}<input type="number" min={0.001} max={60} step="0.001" value={draft.durationMs / 1000}
        onChange={event => {
          const ms = Math.round(event.currentTarget.valueAsNumber * 1000);
          if (Number.isFinite(ms) && ms >= 1 && ms <= 60_000) update({ durationMs: ms });
        }} /></label>
    </div>

    <ClipVideoInputs draft={draft} profile={profile} change={videoInputs => update({ videoInputs })} />
    <div className="comic-section-heading"><h3>{t("场景 / 道具 / 音效素材引用")}</h3>
      <div className="comic-actions">
        <button type="button" onClick={() => setPicker({ kind: "scene" })}>{t(draft.sceneRef ? "更换场景图" : "绑定场景图")}</button>
        <button type="button" disabled={(draft.propRefs?.length ?? 0) >= 10} onClick={() => setPicker({ kind: "prop" })}>＋ {t("绑定道具图")}</button>
        <button type="button" disabled={(draft.sfxRefs?.length ?? 0) >= 10} onClick={() => setPicker({ kind: "sound" })}>＋ {t("绑定分镜音效")}</button>
        <button type="button" disabled={generateDisabled} onClick={() => setGenerating("scene")}>{t("生成场景图")}</button>
        <button type="button" disabled={generateDisabled || (draft.propRefs?.length ?? 0) >= 10}
          onClick={() => setGenerating("prop")}>{t("生成道具图")}</button>
      </div>
    </div>
    {(draft.sceneRef || (draft.propRefs?.length ?? 0) > 0 || (draft.sfxRefs?.length ?? 0) > 0) && (
      <div className="comic-ref-chips">
        {draft.sceneRef && <span className="comic-ref-chip">
          <span>{t("场景")} · {draft.sceneRef.name ?? draft.sceneRef.materialId.slice(0, 8)}</span>
          <button type="button" aria-label={t("移除")} onClick={() => update({ sceneRef: null })}>×</button>
        </span>}
        {(draft.propRefs ?? []).map(ref => <span className="comic-ref-chip" key={ref.mediaId}>
          <span>{t("道具")} · {ref.name ?? ref.materialId.slice(0, 8)}</span>
          <button type="button" aria-label={t("移除")}
            onClick={() => update({ propRefs: (draft.propRefs ?? []).filter(item => item.mediaId !== ref.mediaId) })}>×</button>
        </span>)}
        {(draft.sfxRefs ?? []).map(ref => <span className="comic-ref-chip" key={ref.mediaId}>
          <span>{t("音效")} · {ref.name ?? ref.materialId.slice(0, 8)}</span>
          <button type="button" aria-label={t("移除")}
            onClick={() => update({ sfxRefs: (draft.sfxRefs ?? []).filter(item => item.mediaId !== ref.mediaId) })}>×</button>
        </span>)}
      </div>
    )}
    {picker && picker.shotIndex === undefined && (
      <MaterialRefPicker kind={picker.kind} choose={mat => pickMaterial(picker, mat)} close={() => setPicker(null)} />
    )}
    {generating && !generateDisabled && <MaterialImageGeneration kind={generating} styleKey={styleKey}
      initialDescription={generating === "scene" ? draft.scene : undefined} close={() => setGenerating(null)}
      submitted={(result, name) => setImageTask({ kind: generating, name, id: result.id })} />}
    {imageTask && <StoryboardMaterialResult key={imageTask.id} task={imageTask}
      disabled={generateDisabled || imageTask.kind === "prop" && (draft.propRefs?.length ?? 0) >= 10}
      bind={ref => { bindMaterial(imageTask, ref); setImageTask(null); }} close={() => setImageTask(null)} />}

    <ClipCast cast={cast} current={draft.cast ?? []} change={actors => update({ cast: actors })} />
    <div className="comic-section-heading"><h3>{t("镜头")}</h3>
      <button type="button" disabled={draft.shots.length >= 3 || !firstFraming || !firstMovement} onClick={() => {
        if (firstFraming && firstMovement) setShots([...draft.shots, {
          id: crypto.randomUUID(), framingKey: firstFraming, movementKey: firstMovement, description: "", durationShare: 100,
        }]);
      }}>＋ {t("添加镜头")}</button>
    </div>
    {draft.shots.map((shot, index) => <div className="comic-subcard" key={shot.id}>
      <div className="comic-actions">
        <label>{t("景别")}<DictionaryOptions choices={framing} value={shot.framingKey} existing={shot.framingKey}
          onChange={event => updateShot(index, { framingKey: event.target.value })} /></label>
        <label>{t("运镜")}<DictionaryOptions choices={movement} value={shot.movementKey} existing={shot.movementKey}
          onChange={event => updateShot(index, { movementKey: event.target.value })} /></label>
        <label className="comic-share-field">{t("时长占比（%）")}
          <input type="number" min={1} max={100} value={shot.durationShare} disabled={draft.shots.length <= 1}
            onChange={event => {
              const value = event.currentTarget.valueAsNumber;
              if (Number.isFinite(value)) update({ shots: rebalanceShotDurationShares(draft.shots, index, value) });
            }} />
        </label>
        <button type="button" disabled={(shot.sfxRefs?.length ?? 0) >= 5} onClick={() => setPicker({ kind: "sound", shotIndex: index })}>
          ＋ {t("镜头音效")}
        </button>
        <button type="button" disabled={draft.shots.length <= 1} onClick={() => setShots(draft.shots.filter(item => item.id !== shot.id))}>
          {t("删除镜头")}
        </button>
      </div>
      <label>{t("镜头描述")}<textarea rows={3} maxLength={2000} value={shot.description}
        onChange={event => updateShot(index, { description: event.target.value })} /></label>
      {(shot.sfxRefs?.length ?? 0) > 0 && (
        <div className="comic-ref-chips comic-shot-sfx-list">
          {(shot.sfxRefs ?? []).map((sfx, sfxIndex) => (
            <span className="comic-ref-chip comic-shot-sfx-chip" key={`${sfx.mediaId}-${sfxIndex}`}>
              <span>{t("音效")} · {sfx.name ?? sfx.materialId.slice(0, 8)}</span>
              <select aria-label={t("音效入点位置")} value={sfx.position ?? "start"} onChange={event => {
                const pos = event.target.value as ComicShotSfxPosition;
                const nextSfx = (shot.sfxRefs ?? []).map((item, i) => i === sfxIndex ? { ...item, position: pos, offsetMs: undefined } : item);
                updateShot(index, { sfxRefs: nextSfx });
              }}>
                <option value="start">{t("镜头开始")}</option>
                <option value="middle">{t("镜头中段")}</option>
                <option value="end">{t("镜头结尾")}</option>
              </select>
              <button type="button" aria-label={t("移除")} onClick={() => {
                const nextSfx = (shot.sfxRefs ?? []).filter((_, i) => i !== sfxIndex);
                updateShot(index, { sfxRefs: nextSfx.length ? nextSfx : undefined });
              }}>×</button>
            </span>
          ))}
        </div>
      )}
      {picker && picker.shotIndex === index && <MaterialRefPicker kind="sound" choose={mat => pickMaterial(picker, mat)} close={() => setPicker(null)} />}
    </div>)}
    <div className="comic-section-heading"><h3>{t("台词")}</h3>
      <button type="button" disabled={draft.lines.length >= 30} onClick={() => update({
        lines: [...draft.lines, { id: crypto.randomUUID(), speaker: null, text: "", emotionKey: null, speed: 1 }],
      })}>＋ {t("添加台词")}</button>
    </div>
    {draft.lines.map((line, index) => {
      const isCastSpeaker = !!line.speaker && castNames.includes(line.speaker);
      const selectVal = !line.speaker ? "__narrator__" : isCastSpeaker ? line.speaker : "__custom__";
      return <div className="comic-subcard" key={line.id}>
        <div className="comic-actions">
          <label>{t("说话人")}
            <select aria-label={t("从选角选择说话人")} value={selectVal} onChange={event => {
              const val = event.target.value;
              if (val === "__narrator__") updateLine(index, { speaker: null });
              else if (val === "__custom__") updateLine(index, { speaker: isCastSpeaker || !line.speaker ? t("自定义角色") : line.speaker });
              else updateLine(index, { speaker: val });
            }}>
              <option value="__narrator__">{t("旁白")}</option>
              {cast.map(({ snapshot }) => <option key={snapshot.characterId} value={snapshot.name}>{snapshot.name}</option>)}
              <option value="__custom__">{t("自定义说话人")}</option>
            </select>
          </label>
          {selectVal === "__custom__" && (
            <label>{t("说话人名称")}<input maxLength={120} value={line.speaker ?? ""} placeholder={t("旁白")}
              onChange={event => updateLine(index, { speaker: event.target.value || null })} /></label>
          )}
          <label>{t("情绪")}<DictionaryOptions choices={emotions} value={line.emotionKey ?? ""} existing={line.emotionKey} empty="—"
            onChange={event => updateLine(index, { emotionKey: event.target.value || null })} /></label>
          <label>{t("语速")}<select value={line.speed} onChange={event => updateLine(index, { speed: Number(event.target.value) })}>
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map(speed => <option key={speed} value={speed}>{speed}×</option>)}
          </select></label>
          <button type="button" onClick={() => update({ lines: draft.lines.filter(item => item.id !== line.id) })}>{t("删除台词")}</button>
        </div>
        <label>{t("台词文本")}<textarea maxLength={1000} value={line.text} onChange={event => updateLine(index, { text: event.target.value })} /></label>
      </div>;
    })}
  </fieldset>;
}

function StoryboardMaterialResult({ task, disabled, bind, close }: {
  task: { id: string; name: string }; disabled: boolean; bind: (ref: ComicMaterialRef) => void; close: () => void;
}) {
  const { t } = useI18n();
  const load = useCallback((signal: AbortSignal) => comicGenerationApi.status(task.id, signal), [task.id]);
  const { current, failed, refresh } = useGenerationHistory(load, 5_000, 0, {
    shouldPoll: data => data.active || hasActiveComicTakes(data.takes),
  });
  const take = current?.takes[0];
  const mediaId = take?.state === "ready" ? take.mediaId : null;
  return <div className="comic-track-picker">
    <strong>{task.name}</strong>
    {failed && <button type="button" onClick={refresh}>{t("重新读取")}</button>}
    {take ? <ComicTakeStatus take={take} /> : !failed && <small role="status">{t("加载中…")}</small>}
    {take && <ImageTakeActions take={take} refreshed={refresh} />}
    {take && mediaId && <MediaPreview media={{ id: mediaId, hasThumbnail: true, durationMs: null }} title={task.name} thumbOnly />}
    <div className="comic-actions">
      {take && mediaId && <button type="button" disabled={disabled} onClick={() => bind({ materialId: take.targetId, mediaId, name: task.name })}>
        {t("绑定到此分镜")}
      </button>}
      <button type="button" onClick={close}>{t("关闭")}</button>
    </div>
  </div>;
}

function ClipVideoInputs({ draft, profile, change }: {
  draft: ComicDramaClipDraft; profile?: ComicVideoProfile; change: (value: ComicDramaClipDraft["videoInputs"]) => void;
}) {
  const { t } = useI18n();
  const input = draft.videoInputs;
  const refs = input?.references ?? [];
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<ComicVideoMaterialRef["kind"] | null>(null);
  const [media, setMedia] = useState<Record<string, ComicMedia | undefined>>({});
  const savedRefs = useRef(refs);
  savedRefs.current = refs;
  const refKey = refs.map(ref => `${ref.materialId}:${ref.mediaId}`).join(",");
  useEffect(() => {
    if (!open || !refKey) return;
    const controller = new AbortController();
    void Promise.all(savedRefs.current.map(async ref => {
      const versions = await comicLibraryApi.materialVersions(ref.materialId, controller.signal).catch(() => []);
      return [ref.mediaId, versions.find(item => item.media.id === ref.mediaId)?.media] as const;
    })).then(values => { if (!controller.signal.aborted) setMedia(Object.fromEntries(values)); });
    return () => controller.abort();
  }, [open, refKey]);
  const seconds = (items: ComicVideoMaterialRef[]) => {
    if (!items.every(ref => media[ref.mediaId]?.durationMs)) return t("待核实");
    return `${items.reduce((sum, ref) => sum + (media[ref.mediaId]?.durationMs ?? 0), 0) / 1000} s`;
  };
  const pickMime = pick === "last_frame" ? "image" : pick;
  const update = (value: Partial<NonNullable<ComicDramaClipDraft["videoInputs"]>>) => change({ ...input, references: refs, ...value });
  const hasAudioRef = refs.some(ref => ref.kind === "audio");
  const audioMode = resolveComicVideoAudioMode(input?.audioMode, hasAudioRef);
  const foldedCount = countComicClipFoldedReferences(draft);
  const hasAdaptation = foldedCount > 0 || Boolean(input?.modelAdaptation?.originalResolution) || Boolean(input?.modelAdaptation?.originalSourceDuration);
  return <details className="comic-video-references" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("分镜视频输入（{0}）", [refs.length])}</summary>
    <div className="comic-clip-fields">
      <label>{t("音频来源模式")}
        <select aria-label={t("音频来源模式")} value={audioMode} onChange={event => {
          const nextMode = event.target.value as ComicVideoAudioMode;
          update({ audioMode: nextMode });
        }}>
          <option value="silent_tts">{t("无声生成 + 后期配音（默认）")}</option>
          <option value="native_audio">{t("模型原生音画对白（含人声，后期仅铺字幕）")}</option>
          <option value="reference_audio">{t("外部参考音频驱动口型")}</option>
        </select>
      </label>
      <small className="comic-safe-hint">
        {t("跨模型安全范围：{0}–{1} 整秒 · ≤{2} 张图 · ≤{3} 个文件 · 音视频各 ≤{4} 秒 · 音频不单传", [
          COMIC_VIDEO_SAFE_COMMON_LIMITS.minSeconds,
          COMIC_VIDEO_SAFE_COMMON_LIMITS.maxSeconds,
          COMIC_VIDEO_SAFE_COMMON_LIMITS.maxImages,
          COMIC_VIDEO_SAFE_COMMON_LIMITS.maxTotalFiles,
          COMIC_VIDEO_SAFE_COMMON_LIMITS.maxAudioTotalSeconds,
        ])}
      </small>
      {hasAdaptation && (
        <div className="comic-compat-box" role="note">
          <small>
            {t("已启用模型兼容适配（折叠 {0} 张超限参考图{1}），原绑定已保留，切回高规格模型可自动恢复。", [
              foldedCount,
              input?.modelAdaptation?.originalResolution ? ` · ${t("原分辨率 {0}", [input.modelAdaptation.originalResolution])}` : "",
            ])}
          </small>
          <button type="button" onClick={() => update({
            resolution: input?.modelAdaptation?.originalResolution ?? input?.resolution,
            sourceDuration: input?.modelAdaptation?.originalSourceDuration ? true : input?.sourceDuration,
            modelAdaptation: undefined,
          })}>{t("恢复原绑定")}</button>
        </div>
      )}
      {profile && <>
        <small role={comicVideoDurationSupported(draft.durationMs, profile) ? undefined : "status"}>
          {t("目标时长 {0} 秒 · 允许 4–{1} 整秒", [draft.durationMs / 1000, profile.shotMaxSeconds])}
        </small>
        <label>{t("输出分辨率")}<select aria-label={t("输出分辨率")} value={input?.resolution ?? ""} onChange={event => {
          const resolution = profile.resolutions.find(value => value === event.target.value);
          update({ resolution });
        }}>
          <option value="">{t("默认")} · {profile.resolution}</option>
          {input?.resolution && !profile.resolutions.includes(input.resolution) && <option value={input.resolution}>
            {input.resolution} · {t("超出模型限制")}
          </option>}
          {profile.resolutions.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
        {profile.operations.includes("extend") && <label className="comic-video-replace">
          <input type="checkbox" checked={!!input?.sourceDuration}
            onChange={event => update({ sourceDuration: event.target.checked ? true : undefined })} />
          {t("延长时使用自动时长")}
        </label>}
        <div className="comic-actions">
          {(["image", "audio", "video"] as const).map(kind => {
            const items = refs.filter(ref => ref.kind === kind);
            const max = kind === "image" ? profile.referenceImages.total : profile.referenceMedia.count;
            return <small key={kind}>{t(videoInputLabels[kind])} {items.length}/{max}
              {kind !== "image" && ` · ${seconds(items)} / ${profile.shotMaxSeconds} s`}</small>;
          })}
          <small>{t("已手动绑定 {0} / {1} 个参考文件", [refs.filter(ref => ref.kind !== "last_frame").length, profile.referenceMedia.totalFiles])}</small>
        </div>
      </>}
      <div className="comic-actions">
        {(Object.keys(videoInputLabels) as ComicVideoMaterialRef["kind"][]).map(kind =>
          <button type="button" key={kind} disabled={refs.length >= 51} onClick={() => setPick(kind)}>
            {t("绑定{0}", [t(videoInputLabels[kind])])}
          </button>)}
      </div>
      {refs.map(ref => <div className="comic-actions" key={`${ref.kind}:${ref.mediaId}`}>
        <small>{t(videoInputLabels[ref.kind])} · {ref.name ?? ref.mediaId.slice(0, 8)}
          {(ref.kind === "video" || ref.kind === "audio") && ` · ${seconds([ref])}`}</small>
        <button type="button" onClick={() => update({ references: refs.filter(item => item !== ref) })}>{t("移除")}</button>
      </div>)}
      {pick && pickMime && <MaterialRefPicker key={pick} kind={pick === "video" ? "other" : undefined} mime={pickMime}
        choose={item => {
          const ref = { kind: pick, materialId: item.id, mediaId: item.media.id, name: item.name };
          const kept = refs.filter(existing => existing.kind !== pick || (pick !== "last_frame" && existing.materialId !== item.id));
          setMedia(current => ({ ...current, [item.media.id]: item.media }));
          update({ references: [...kept, ref] });
          setPick(null);
        }} close={() => setPick(null)} />}
    </div>
  </details>;
}

function MaterialRefPicker({ kind, mime, choose, close }: {
  kind?: ComicMaterialKind;
  mime?: "image" | "audio" | "video";
  choose: (material: ComicMaterial) => void;
  close: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ComicLibraryPage<ComicMaterial> | "error" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    void comicLibraryApi.materials({ ...(kind ? { kind } : {}), ...(mime ? { mime } : {}), query, page: String(page) }, controller.signal).then(res => {
      if (!controller.signal.aborted) setData(res);
    }).catch(() => { if (!controller.signal.aborted) setData("error"); });
    return () => controller.abort();
  }, [kind, mime, query, page]);
  return <div className="comic-track-picker">
    <div className="comic-actions">
      <label>{t("搜索素材")}<input value={query} maxLength={120} onChange={e => { setQuery(e.target.value); setPage(1); }} /></label>
      <button type="button" onClick={close}>{t("取消")}</button>
    </div>
    {data === null ? <p role="status">{t("加载中…")}</p> : data === "error" ? <p role="alert">{t("操作失败，请重试")}</p> : (
      data.entries.length === 0 ? <p>{t("暂无匹配的素材")}</p> : (
        <div className="comic-library-grid">
          {data.entries.map(item => (
            <article key={item.id} className="comic-library-card">
              <MediaPreview media={item.media} title={item.name} thumbOnly />
              <strong>{item.name}</strong>
              {mime && <small>{[item.media.width && item.media.height ? `${item.media.width}×${item.media.height}` : "",
                item.media.durationMs ? `${item.media.durationMs / 1000} s` : "", `${(item.media.sizeBytes / 1e6).toFixed(1)} MB`].filter(Boolean).join(" · ")}</small>}
              <button type="button" onClick={() => choose(item)}>{t("选择此素材")}</button>
            </article>
          ))}
        </div>
      )
    )}
    {data && data !== "error" && (page > 1 || data.more) && <div className="comic-actions">
      <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t("上一页")}</button>
      <button type="button" disabled={!data.more} onClick={() => setPage(p => p + 1)}>{t("下一页")}</button>
    </div>}
  </div>;
}


function ClipCast({ cast, current, change }: { cast: readonly ComicSeriesCast[]; current: ComicClipCasting; change: (value: ComicClipCasting) => void }) {
  const { t, locale } = useI18n();
  const slots = useComicChoices("slot");
  const expressions = useComicChoices("expression");
  const choices = cast.filter(entry => !current.some(actor => actor.characterId === entry.snapshot.characterId));
  const add = (id: string) => {
    const snapshot = choices.find(entry => entry.snapshot.characterId === id)?.snapshot;
    if (!snapshot) return;
    const slot = snapshot.assets.find(asset => asset.kind === "slot" && asset.key === "front") ??
      snapshot.assets.find(asset => asset.kind === "slot");
    change([...current, { characterId: id, slotKey: slot?.key ?? null, expressionKey: null }]);
  };
  return <>
    <div className="comic-section-heading"><h3>{t("出镜人物")}</h3></div>
    {current.map((actor, index) => {
      const snapshot = cast.find(entry => entry.snapshot.characterId === actor.characterId)?.snapshot;
      if (!snapshot) return null;
      const update = (fields: Partial<typeof actor>) => change(current.map((entry, i) => i === index ? { ...entry, ...fields } : entry));
      return <div className="comic-subcard" key={actor.characterId}>
        <div className="comic-actions"><strong>{snapshot.name}</strong> <small>{snapshot.outfitName}</small>
          <button type="button" onClick={() => change(current.filter((_, i) => i !== index))}>{t("移除出镜")}</button>
        </div>
        <div className="comic-fields">
          <label>{t("造型槽位")}<select value={actor.slotKey ?? ""} onChange={event => update({ slotKey: event.target.value || null })}>
            <option value="">{t("仅用角色描述")}</option>
            {snapshot.assets.filter(asset => asset.kind === "slot").map(asset =>
              <option value={asset.key} key={asset.key}>{slots.find(row => row.key === asset.key)?.labels[locale] ?? asset.key}</option>)}
          </select></label>
          <label>{t("表情")}<select value={actor.expressionKey ?? ""} onChange={event => update({ expressionKey: event.target.value || null })}>
            <option value="">—</option>
            {snapshot.assets.filter(asset => asset.kind === "expression").map(asset =>
              <option value={asset.key} key={asset.key}>{expressions.find(row => row.key === asset.key)?.labels[locale] ?? asset.key}</option>)}
          </select></label>
        </div>
      </div>;
    })}
    <label className="comic-actor-add">{t("添加出镜角色")}<select aria-label={t("添加出镜角色")} value="" disabled={!choices.length || current.length >= 32}
      onChange={event => add(event.target.value)}>
      <option value="">{t(cast.length === 0 ? "先在选角中添加角色" : "请选择")}</option>
      {choices.map(({ snapshot }) => <option value={snapshot.characterId} key={snapshot.characterId}>{snapshot.name}</option>)}
    </select></label>
  </>;
}

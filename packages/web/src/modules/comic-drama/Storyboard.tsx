import { useEffect, useRef, useState } from "react";
import {
  checkComicClipIssues, rebalanceShotDurationShares, type ComicClipCheckIssue, type ComicClipCasting, type ComicDramaClip,
  type ComicDramaClipDraft, type ComicDramaSeries, type ComicLibraryPage, type ComicMaterial, type ComicMaterialKind,
  type ComicMaterialRef, type ComicSeriesCast, type ComicShotSfxPosition, type ComicShotSfxRef,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicLibraryApi } from "./library-api.js";
import { DictionaryOptions, MediaPreview, useComicChoices } from "./LibraryParts.js";

type Props = {
  series?: Pick<ComicDramaSeries, "videoModel">;
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
  series, clips, cast, drafts, disabled, locked, selected, select, edit, add, copy, remove, reorder, onEnhanceClip,
}: Props) {
  const { t } = useI18n();
  const dragging = useRef<string | null>(null);
  const clip = clips.find(entry => entry.id === selected) ?? clips[0];
  const activeDraft = clip ? (drafts[clip.id]?.draft ?? clip.draft) : null;
  const clipIssues = clip && activeDraft
    ? checkComicClipIssues({ videoModel: series?.videoModel ?? null }, { ...clip, draft: activeDraft }, cast)
    : [];
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
                {itemIssues.length > 0 && <small className="comic-pill" data-tone="warn">{t("{0} 项提醒", [itemIssues.length])}</small>}
              </span>
            </span>
          </button>
        </div>;
      })}
      <button type="button" className="comic-add" disabled={disabled} onClick={() => add()}>＋ {t("添加分镜")}</button>
    </section>
    {clip && activeDraft && <section className="comic-edit-card">
      <header>
        <div>
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
        addCast={characterId => {
          const member = cast.find(entry => entry.snapshot.characterId === characterId);
          if (!member || (activeDraft.cast ?? []).some(a => a.characterId === characterId)) return;
          const slot = member.snapshot.assets.find(asset => asset.kind === "slot" && asset.key === "front")
            ?? member.snapshot.assets.find(asset => asset.kind === "slot");
          edit(clip.id, { ...activeDraft, cast: [...(activeDraft.cast ?? []), { characterId, slotKey: slot?.key ?? null, expressionKey: null }] });
        }} />}
      <ClipFields key={clip.id} draft={activeDraft} disabled={locked} cast={cast} change={draft => edit(clip.id, draft)} />
    </section>}
  </div>;
}

function ClipIssueBanner({ issues, cast, disabled, addCast }: {
  issues: ComicClipCheckIssue[]; cast: readonly ComicSeriesCast[]; disabled: boolean; addCast: (characterId: string) => void;
}) {
  const { t } = useI18n();
  return <div className="comic-issue-banner" role="status">
    <strong>{t("分镜查漏提醒")}</strong>
    <ul>{issues.map((issue, idx) => (
      <li key={idx}>
        {issue.code === "SPEAKER_NOT_IN_CAST" && <>
          <span>{t("台词说话人「{0}」未在本镜出镜人物中", [issue.speaker])}</span>
          {!disabled && issue.suggestedCharacterId && cast.some(c => c.snapshot.characterId === issue.suggestedCharacterId) && (
            <button type="button" onClick={() => addCast(issue.suggestedCharacterId!)}>{t("一键加入出镜")}</button>
          )}
        </>}
        {issue.code === "REFERENCE_LIMIT_EXCEEDED" && (
          <span>{t("当前参考图共 {0} 张，超出模型上限（{1} 张）", [issue.count, issue.limit])}</span>
        )}
        {issue.code === "DIALOGUE_TOO_LONG" && (
          <span>{t("台词估算约 {0} 秒，超出本镜时长（{1} 秒）", [+(issue.estimatedMs / 1000).toFixed(1), +(issue.durationMs / 1000).toFixed(1)])}</span>
        )}
        {issue.code === "CAST_UPDATED_IN_LIBRARY" && (
          <span>{issue.reason === "generated_outdated"
            ? t("角色「{0}」当前造型已晚于已生成版本，建议核对或重生成", [issue.characterName])
            : t("角色「{0}」在角色库中有更新，可到选角处同步", [issue.characterName])}</span>
        )}
        {issue.code === "INVALID_MATERIAL_REFERENCE" && (
          <span>{t("所绑定的{0}素材「{1}」已失效（{2}），请重新绑定或移除", [
            t(issue.role === "scene" ? "场景" : issue.role === "prop" ? "道具" : "音效"),
            issue.name ?? issue.materialId.slice(0, 8),
            t(issue.reason === "ARCHIVED" ? "已归档" : issue.reason === "OUTDATED_VERSION" ? "已有新版"
              : issue.reason === "WRONG_KIND" ? "类别不符" : "已缺失"),
          ])}</span>
        )}
      </li>
    ))}</ul>
  </div>;
}

function ClipFields({ draft, disabled, cast, change }: {
  draft: ComicDramaClipDraft; disabled: boolean; cast: readonly ComicSeriesCast[]; change: (draft: ComicDramaClipDraft) => void;
}) {
  const { t } = useI18n();
  const framing = useComicChoices("framing");
  const movement = useComicChoices("movement");
  const emotions = useComicChoices("emotion");
  const [picker, setPicker] = useState<{ kind: "scene" | "prop" | "sound"; shotIndex?: number } | null>(null);
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
  const pickMaterial = (target: { kind: "scene" | "prop" | "sound"; shotIndex?: number }, material: ComicMaterial) => {
    const ref: ComicMaterialRef = { materialId: material.id, mediaId: material.media.id, name: material.name };
    if (target.kind === "scene") {
      update({ sceneRef: ref });
    } else if (target.kind === "prop") {
      const current = draft.propRefs ?? [];
      if (!current.some(item => item.mediaId === ref.mediaId) && current.length < 10) {
        update({ propRefs: [...current, ref] });
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

    <div className="comic-section-heading"><h3>{t("场景 / 道具 / 音效素材引用")}</h3>
      <div className="comic-actions">
        <button type="button" onClick={() => setPicker({ kind: "scene" })}>{t(draft.sceneRef ? "更换场景图" : "绑定场景图")}</button>
        <button type="button" disabled={(draft.propRefs?.length ?? 0) >= 10} onClick={() => setPicker({ kind: "prop" })}>＋ {t("绑定道具图")}</button>
        <button type="button" disabled={(draft.sfxRefs?.length ?? 0) >= 10} onClick={() => setPicker({ kind: "sound" })}>＋ {t("绑定分镜音效")}</button>
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

function MaterialRefPicker({ kind, choose, close }: {
  kind: Extract<ComicMaterialKind, "scene" | "prop" | "sound">;
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
    void comicLibraryApi.materials({ kind, query, page: String(page) }, controller.signal).then(res => {
      if (!controller.signal.aborted) setData(res);
    }).catch(() => { if (!controller.signal.aborted) setData("error"); });
    return () => controller.abort();
  }, [kind, query, page]);
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

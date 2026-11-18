import { useRef } from "react";
import type { ComicClipCasting, ComicDramaClip, ComicDramaClipDraft, ComicSeriesCast } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";

import { DictionaryOptions, useComicChoices } from "./LibraryParts.js";

type Props = {
  clips: readonly ComicDramaClip[];
  cast: readonly ComicSeriesCast[];
  drafts: Readonly<Record<string, { draft: ComicDramaClipDraft }>>;
  disabled: boolean;
  locked: boolean;
  selected: string | null;
  select: (id: string) => void;
  edit: (id: string, draft: ComicDramaClipDraft) => void;
  add: () => void;
  copy: (id: string) => void;
  remove: (id: string) => void;
  reorder: (ids: string[]) => void;
};

export function Storyboard({ clips, cast, drafts, disabled, locked, selected, select, edit, add, copy, remove, reorder }: Props) {
  const { t } = useI18n();
  const dragging = useRef<string | null>(null);
  const clip = clips.find(entry => entry.id === selected) ?? clips[0];
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
      {clips.map((item, index) => <div key={item.id} className={item.id === clip?.id ? "comic-cut selected" : "comic-cut"}
        draggable={!disabled} onDragStart={event => {
          dragging.current = item.id;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", item.id);
        }} onDragEnd={() => { dragging.current = null; }}
        onDragOver={event => { if (!disabled && dragging.current) event.preventDefault(); }}
        onDrop={event => { event.preventDefault(); if (dragging.current) move(dragging.current, index); dragging.current = null; }}>
        <button type="button" aria-pressed={item.id === clip?.id} onClick={() => select(item.id)}>
          <span className="comic-cut-number">{String(item.ordinal).padStart(2, "0")}</span>
          <span>{(drafts[item.id]?.draft ?? item.draft).scene || t("未命名分镜")}</span>
        </button>
      </div>)}
      <button type="button" className="comic-add" disabled={disabled} onClick={add}>＋ {t("添加分镜")}</button>
    </section>
    {clip && <section className="comic-edit-card">
      <header>
        <h2>{t("分镜 {0}", [clip.ordinal])}</h2>
        <div className="comic-actions">
          <button type="button" disabled={disabled || clip.ordinal === 1} onClick={() => move(clip.id, clip.ordinal - 2)}>{t("上移")}</button>
          <button type="button" disabled={disabled || clip.ordinal === clips.length} onClick={() => move(clip.id, clip.ordinal)}>{t("下移")}</button>
          <button type="button" disabled={disabled} onClick={() => copy(clip.id)}>{t("复制分镜")}</button>
          <button type="button" disabled={disabled} onClick={() => remove(clip.id)}>{t("删除")}</button>
        </div>
      </header>
      <ClipFields key={clip.id} draft={drafts[clip.id]?.draft ?? clip.draft} disabled={locked} cast={cast} change={draft => edit(clip.id, draft)} />
    </section>}
  </div>;
}

function ClipFields({ draft, disabled, cast, change }: {
  draft: ComicDramaClipDraft; disabled: boolean; cast: readonly ComicSeriesCast[]; change: (draft: ComicDramaClipDraft) => void;
}) {
  const { t } = useI18n();
  const framing = useComicChoices("framing");
  const movement = useComicChoices("movement");
  const emotions = useComicChoices("emotion");
  const firstFraming = framing.find(entry => !entry.inactive)?.key;
  const firstMovement = movement.find(entry => !entry.inactive)?.key;
  const update = (values: Partial<ComicDramaClipDraft>) => change({ ...draft, ...values });
  const updateShot = (index: number, values: Partial<ComicDramaClipDraft["shots"][number]>) =>
    update({ shots: draft.shots.map((shot, i) => i === index ? { ...shot, ...values } : shot) });
  const updateLine = (index: number, values: Partial<ComicDramaClipDraft["lines"][number]>) =>
    update({ lines: draft.lines.map((line, i) => i === index ? { ...line, ...values } : line) });
  const setShots = (shots: ComicDramaClipDraft["shots"]) => {
    const share = Math.floor(100 / shots.length);
    update({ shots: shots.map((shot, i) => ({ ...shot, durationShare: i === shots.length - 1 ? 100 - share * i : share })) });
  };
  return <fieldset disabled={disabled} className="comic-clip-fields">
    <div className="comic-fields">
      <label>{t("场景")}<input maxLength={1000} value={draft.scene} onChange={event => update({ scene: event.target.value })} /></label>
      <label>{t("时长（秒）")}<input type="number" min={0.001} max={60} step="0.001" value={draft.durationMs / 1000}
        onChange={event => {
          const ms = Math.round(event.currentTarget.valueAsNumber * 1000);
          if (Number.isFinite(ms) && ms >= 1 && ms <= 60_000) update({ durationMs: ms });
        }} /></label>
    </div>
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
        <span className="comic-shot-share">{shot.durationShare}%</span>
        <button type="button" onClick={() => setShots(draft.shots.filter(item => item.id !== shot.id))}>{t("删除镜头")}</button>
      </div>
      <label>{t("镜头描述")}<textarea rows={3} maxLength={2000} value={shot.description}
        onChange={event => updateShot(index, { description: event.target.value })} /></label>
    </div>)}
    <div className="comic-section-heading"><h3>{t("台词")}</h3>
      <button type="button" disabled={draft.lines.length >= 30} onClick={() => update({
        lines: [...draft.lines, { id: crypto.randomUUID(), speaker: null, text: "", emotionKey: null, speed: 1 }],
      })}>＋ {t("添加台词")}</button>
    </div>
    {draft.lines.map((line, index) => <div className="comic-subcard" key={line.id}>
      <div className="comic-actions">
        <label>{t("说话人")}<input maxLength={120} value={line.speaker ?? ""} placeholder={t("旁白")}
          onChange={event => updateLine(index, { speaker: event.target.value || null })} /></label>
        <label>{t("情绪")}<DictionaryOptions choices={emotions} value={line.emotionKey ?? ""} existing={line.emotionKey} empty="—"
          onChange={event => updateLine(index, { emotionKey: event.target.value || null })} /></label>
        <label>{t("语速")}<select value={line.speed} onChange={event => updateLine(index, { speed: Number(event.target.value) })}>
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map(speed => <option key={speed} value={speed}>{speed}×</option>)}
        </select></label>
        <button type="button" onClick={() => update({ lines: draft.lines.filter(item => item.id !== line.id) })}>{t("删除台词")}</button>
      </div>
      <label>{t("台词文本")}<textarea maxLength={1000} value={line.text} onChange={event => updateLine(index, { text: event.target.value })} /></label>
    </div>)}
  </fieldset>;
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

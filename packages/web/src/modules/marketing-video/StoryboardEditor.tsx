import { useState } from "react";
import { marketingMaxDuration, type MarketingDraft, type MarketingShot } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { insertShot, MARKETING_MIN_SHOT_SECONDS, mergeShots, moveShot, removeShot, setShotDuration, shotsWithoutTake, splitShot } from "./shot-structure.js";

const shotEnds = (shots: Pick<MarketingShot, "durationSec">[]) =>
  shots.reduce<number[]>((times, shot) => [...times, (times.at(-1) ?? 0) + (shot.durationSec ?? 15)], []);

/** One line per shot: its time span and what it shows. */
export function ShotOverview({ shots }: { shots: MarketingShot[] }) {
  const { t } = useI18n();
  const ends = shotEnds(shots);
  return <ol className="mv-shot-overview">{shots.map((shot, index) => <li key={index}>
    <span>{t("第 {0} 镜", [index + 1])} · {index ? ends[index - 1] : 0}–{ends[index]}s</span><p>{shot.visual || shot.script}</p>
  </li>)}</ol>;
}

/** What the board may change before a video is made: shot times and order. */
export interface StoryboardStructure {
  /** Target length of the video, and the longest shot the model accepts for this draft. */
  durationSec: number; maxShot: number;
  /** Lines that have a twin narration take, when the draft is narrated by the twin. */
  takes?: ReadonlySet<string>;
}

export function StoryboardEditor({ shots, presenter = "mixed", busy, readOnly = false, compact = false, redo, structure, onChange, onAi }: {
  shots: MarketingShot[];
  presenter?: MarketingDraft["presenter"];
  busy: boolean;
  readOnly?: boolean;
  /** Inside a panel that already shows the heading and totals. */
  compact?: boolean;
  /** A made video: the shots to redo. A shot with a reason (edited, no usable clip) stays chosen;
   * a note says what happens to an optional one that is left out. */
  redo?: { selected: boolean[]; reasons: (string | undefined)[]; notes?: (string | undefined)[]; onToggle(index: number): void;
    /** The clip each shot has now, watched before choosing to redo it. */
    clips?: (string | null | undefined)[] };
  /** Shot times, order and count may change too. */
  structure?: StoryboardStructure;
  onChange?: (shots: MarketingShot[]) => void;
  onAi?: (instruction: string, index?: number) => void;
}) {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const [target, setTarget] = useState("all");
  // The last structure edit can be undone while the board is still what it made.
  const [undo, setUndo] = useState<{ before: MarketingShot[]; after: MarketingShot[] } | null>(null);
  const restructure = (next: MarketingShot[] | null) => {
    if (!next) return;
    setUndo({ before: shots, after: next });
    onChange?.(next);
  };
  const lastEdit = undo?.after === shots ? undo : null;
  const total = shots.reduce((sum, shot) => sum + (shot.durationSec ?? 15), 0);
  const fields = [{ key: "script", label: "分镜口播", max: 600 }, { key: "visual", label: "画面内容", max: 600 }, { key: "action", label: "人物与产品动作", max: 400 }, { key: "camera", label: "景别与镜头运动", max: 400 }] as const;
  const ends = shotEnds(shots);
  return <div className="mv-storyboard">
    {!compact && <div className="mv-section-head"><h3>{t(readOnly || redo ? "制作分镜" : "确认分镜")}</h3><span>{t("{0} 个分镜 · 共 {1} 秒", [shots.length, ends.at(-1) ?? 0])}</span></div>}
    <p className="mv-hint">{t(redo ? "修改镜头内容或勾选「重新生成此镜」，只重新生成这些镜头并重新合成；其余镜头沿用已生成的片段，不收费。镜数和每镜时长不可修改。"
      : readOnly ? "以下是本次制作使用的分镜。修改后需作为新视频重新生成。"
      : presenter === "mixed" ? "人物出镜与否按分镜安排，请在画面内容中写明该镜是否有人物出镜。" : "出镜人物将在每个镜头出镜，保持形象一致。")}</p>
    {structure && !readOnly && <StructureStatus structure={structure} shots={shots} total={total} busy={busy} lastEdit={lastEdit}
      onUndo={() => { if (lastEdit) { setUndo(null); onChange?.(lastEdit.before); } }} />}
    <div className="mv-shot-list">{shots.map((shot, index) => <article className={redo?.selected[index] ? "mv-shot mv-shot-redo" : "mv-shot"} key={index} aria-label={t("第 {0} 镜", [index + 1])}>
      <header><h4>{t("第 {0} 镜", [index + 1])}</h4>{structure && !readOnly
        ? <label className="mv-shot-duration"><span>{index ? ends[index - 1] : 0}–{ends[index]}s</span>
          <select aria-label={t("第 {0} 镜时长", [index + 1])} value={shot.durationSec} disabled={busy}
            onChange={e => onChange?.(setShotDuration(shots, index, Number(e.target.value)))}>
            {shotSeconds(structure.maxShot, shot.durationSec).map(n => <option key={n} value={n}>{t("{0} 秒", [n])}</option>)}
          </select></label>
        : <span>{index ? ends[index - 1] : 0}–{ends[index]}s · {t("{0} 秒", [shot.durationSec ?? 15])}</span>}</header>
      {structure && !readOnly && <div className="mv-shot-tools" role="group" aria-label={t("第 {0} 镜结构", [index + 1])}>
        <button type="button" disabled={busy || !moveShot(shots, index, -1)} onClick={() => restructure(moveShot(shots, index, -1))}>{t("上移")}</button>
        <button type="button" disabled={busy || !moveShot(shots, index, 1)} onClick={() => restructure(moveShot(shots, index, 1))}>{t("下移")}</button>
        <button type="button" disabled={busy || !splitShot(shots, index)} onClick={() => restructure(splitShot(shots, index))}>{t("拆分")}</button>
        <button type="button" disabled={busy || !mergeShots(shots, index, structure.maxShot)}
          onClick={() => restructure(mergeShots(shots, index, structure.maxShot))}>{t("与下一镜合并")}</button>
        <button type="button" disabled={busy || !insertShot(shots, index)} onClick={() => restructure(insertShot(shots, index))}>{t("在后面加一镜")}</button>
        <button type="button" className="mv-danger-text" disabled={busy || !removeShot(shots, index)} onClick={() => restructure(removeShot(shots, index))}>{t("删除")}</button>
      </div>}
      {redo && <label className="mv-checkbox"><input type="checkbox" checked={redo.selected[index]} disabled={busy || !!redo.reasons[index]} onChange={() => redo.onToggle(index)} />
        {t("重新生成此镜")}{redo.reasons[index] ? <em>{t(redo.reasons[index])}</em> : redo.notes?.[index] && !redo.selected[index] && <em>{t(redo.notes[index])}</em>}</label>}
      {redo?.clips?.[index] && <ShotClip url={redo.clips[index]!} index={index} />}
      {fields.map(({ key, label, max }) => <label className="mv-field" key={key}><span>{t(label)}</span>
        <textarea rows={key === "visual" ? 3 : 2} maxLength={max} value={shot[key]} readOnly={readOnly} disabled={busy}
          onChange={e => onChange?.(shots.map((value, i) => i === index ? { ...value, [key]: e.target.value } : value))} /></label>)}
    </article>)}</div>
    {!readOnly && onAi && <details className="mv-storyboard-ai" open><summary>{t("调整分镜（选填）")}</summary>
      <label className="mv-field"><span>{t("AI 修改范围")}</span><select value={target} disabled={busy} onChange={e => setTarget(e.target.value)}><option value="all">{t("全部分镜")}</option>{shots.map((_, index) => <option key={index} value={index}>{t("第 {0} 镜", [index + 1])}</option>)}</select></label>
      <label className="mv-field"><span>{t("分镜修改要求")}</span><textarea rows={2} maxLength={1000} value={instruction} disabled={busy} placeholder={t("例如：开场由人物手持产品展示，保留脸部和上半身，镜头缓慢推近，口播保持不变。")} onChange={e => setInstruction(e.target.value)} /></label>
      <button className="mv-soft" disabled={busy || !instruction.trim()} onClick={() => onAi?.(instruction.trim(), target === "all" ? undefined : Number(target))}>{t(busy ? "正在处理…" : "AI 修改分镜")}</button>
    </details>}
  </div>;
}

/** Seconds a shot may last: 4 up to the model's longest shot, plus a longer saved time so it still shows. */
const shotSeconds = (maxShot: number, current: number) =>
  Array.from({ length: Math.max(maxShot, current) - MARKETING_MIN_SHOT_SECONDS + 1 }, (_, i) => i + MARKETING_MIN_SHOT_SECONDS);

/** The board's total time against the range the video allows, and what the last structure edit changed. */
function StructureStatus({ structure, shots, total, busy, lastEdit, onUndo }: { structure: StoryboardStructure; shots: MarketingShot[]; total: number;
  busy: boolean; lastEdit: { before: MarketingShot[] } | null; onUndo(): void }) {
  const { t } = useI18n();
  const max = marketingMaxDuration(structure.durationSec);
  const fits = total >= structure.durationSec && total <= max;
  const tooLong = shots.some(shot => shot.durationSec > structure.maxShot);
  const missing = lastEdit && structure.takes?.size ? shotsWithoutTake(shots, structure.takes) : [];
  return <>
    <p className={fits && !tooLong ? "mv-hint" : "mv-hint mv-structure-warning"} role="status">
      {t("分镜共 {0} 秒，目标 {1} 秒，可用 {1}–{2} 秒。", [total, structure.durationSec, max])}
      {!fits && ` ${t(total < structure.durationSec ? "请加长镜头或增加镜头。" : "请缩短镜头或删除镜头。")}`}
      {tooLong && ` ${t("当前视频模型每镜最长 {0} 秒。", [structure.maxShot])}`}
    </p>
    {lastEdit && <div className="mv-audio-notice" role="status">
      <p>{t("已调整分镜结构。")}{missing.length ? ` ${t("第 {0} 镜需要重新合成配音，会产生费用。", [missing.map(i => i + 1).join("、")])}` : ""}
        {` ${t("生成前会重新检查文案。")}`}</p>
      <button type="button" disabled={busy} onClick={onUndo}>{t("撤销本次调整")}</button>
    </div>}
  </>;
}

/** A kept clip, loaded only once opened so a long storyboard does not fetch every video. */
function ShotClip({ url, index }: { url: string; index: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <details className="mv-shot-clip" onToggle={e => setOpen(e.currentTarget.open)}><summary>{t("查看本镜片段")}</summary>
    {open && <video controls preload="metadata" src={url} aria-label={t("第 {0} 镜片段", [index + 1])} />}</details>;
}

import { useEffect, useState, type ReactNode } from "react";
import { captionLayout, captionLines, marketingCaptionLinesMatch, marketingCaptionsValue, marketingFrameSize, marketingShotCaption, MarketingCaptionsSchema,
  type MarketingCaption, type MarketingCaptions } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { Choices, type DraftForm } from "./StudioFields.js";

export const CAPTION_SIZES = [{ value: "small", label: "小" }, { value: "medium", label: "标准" }, { value: "large", label: "大" }];
export const CAPTION_POSITIONS = [{ value: "low", label: "靠下" }, { value: "medium", label: "标准" }, { value: "high", label: "靠上" }];
const parseLines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);
export const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

/** Seconds a caption moves, -1 to 1 in 0.05 steps; empty means none. */
export function OffsetField({ label, value, busy, onChange }: { label: string; value: number; busy: boolean; onChange(value: number): void }) {
  const { t } = useI18n();
  return <label className="mv-field mv-caption-offset"><span>{t(label)}</span>
    <input type="number" min={-1} max={1} step={0.05} value={value} disabled={busy}
      onChange={e => onChange(Math.round(Math.min(1, Math.max(-1, Number(e.target.value) || 0)) * 100) / 100)} />
  </label>;
}

/** Message keys of one caption unit; marketing videos edit shots, digital presenters segments. */
export interface CaptionUnitCopy { title: string; aria: string; empty: string; mismatch: string; offset: string }
const SHOT_COPY: CaptionUnitCopy = { title: "第 {0} 镜", aria: "第 {0} 镜字幕", empty: "每镜至少保留一行字幕。",
  mismatch: "字幕只能调整断行和标点；要改文字，请修改该镜口播。", offset: "本镜提前或延后（秒）" };

/** One shot's caption lines as editable text, one caption per line. The text is kept while the
 * user types blank lines; a change made elsewhere (undo, reworded shot) replaces it. */
export function ShotCaption({ index, start, end, lines, auto, mismatch, offsetSec, busy, burned, onLines, onOffset, copy = SHOT_COPY }: {
  index: number; start?: number; end?: number; lines: string[]; auto: boolean; mismatch: boolean; offsetSec: number; busy: boolean;
  burned: MarketingCaption[]; onLines(lines: string[] | undefined): void; onOffset(value: number): void; copy?: CaptionUnitCopy;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(lines.join("\n"));
  useEffect(() => { if (!sameLines(parseLines(text), lines)) setText(lines.join("\n")); }, [lines.join("\n")]);
  const [error, setError] = useState(false);
  return <li className="mv-caption-shot">
    <span>{t(copy.title, [index + 1])}{start !== undefined && end !== undefined && <> · {start}–{end}s</>}
      {!!burned.length && <small>{t("成片中 {0}–{1} 秒，{2} 条", [burned[0].start.toFixed(2), burned.at(-1)!.end.toFixed(2), burned.length])}</small>}</span>
    <textarea aria-label={t(copy.aria, [index + 1])} rows={Math.max(2, lines.length)} value={text} disabled={busy}
      onChange={e => {
        setText(e.target.value);
        const next = parseLines(e.target.value);
        setError(!next.length);
        if (next.length) onLines(next);
      }} />
    {error && <p className="mv-error" role="alert">{t(copy.empty)}</p>}
    {mismatch && <p className="mv-error" role="alert">{t(copy.mismatch)}</p>}
    <div className="mv-caption-row">
      <OffsetField label={copy.offset} value={offsetSec} busy={busy} onChange={onOffset} />
      {!auto && <button type="button" disabled={busy} onClick={() => { setError(false); onLines(undefined); }}>{t("恢复自动断行")}</button>}
    </div>
  </li>;
}

/** Captions burned in when a made video is composed: line breaks, timing, size and position.
 * The words stay the confirmed copy; changes here compose the kept clips again with `recompose`. */
export function CaptionSettings({ form, captions: burned, recompose }: { form: DraftForm; captions?: MarketingCaption[]; recompose?: ReactNode }) {
  const { t } = useI18n();
  const { draft, busy, field } = form;
  const captions = draft.captions ?? MarketingCaptionsSchema.parse({});
  const { width, height } = marketingFrameSize(draft);
  const maxCells = captionLayout(width, height, captions).maxCells;
  const update = (next: Partial<MarketingCaptions>) => field("captions", marketingCaptionsValue({ ...captions, ...next }));
  const updateShot = (index: number, change: { lines?: string[]; offsetSec?: number }) => {
    const script = draft.storyboard[index].script;
    const current = marketingShotCaption(draft, index, script);
    const entry = { script, offsetSec: current?.offsetSec ?? 0, ...(current?.lines ? { lines: current.lines } : {}), ...change };
    if (!entry.lines) delete entry.lines;
    update({ shots: Array.from({ length: Math.max(captions.shots.length, index + 1) }, (_, i) => i === index ? entry : captions.shots[i] ?? null) });
  };
  const ends = draft.storyboard.reduce<number[]>((times, shot) => [...times, (times.at(-1) ?? 0) + shot.durationSec], []);
  return <fieldset className="mv-captions" aria-label={t("调整字幕")}>
    <legend>{t("调整字幕")}</legend>
    <p className="mv-hint">{t("字幕文字来自确认的口播，这里只能调整断行、标点、出现时间、字号和位置；要改文字，请修改下方分镜的口播。")}</p>
    <div className="mv-caption-row">
      <div className="mv-caption-choice"><span>{t("字号")}</span>
        <Choices form={form} label="字号" values={CAPTION_SIZES} value={captions.size} onChoose={value => update({ size: value as MarketingCaptions["size"] })} /></div>
      <div className="mv-caption-choice"><span>{t("位置")}</span>
        <Choices form={form} label="位置" values={CAPTION_POSITIONS} value={captions.position} onChoose={value => update({ position: value as MarketingCaptions["position"] })} /></div>
    </div>
    {captions.position === "low" && height > width && <p className="mv-hint">{t("竖屏字幕靠下时，可能被短视频平台的按钮和标题遮挡。")}</p>}
    <div className="mv-caption-row">
      <OffsetField label="全片提前或延后（秒）" value={captions.offsetSec} busy={busy} onChange={offsetSec => update({ offsetSec })} />
      {recompose}
    </div>
    <p className="mv-hint">{t("负数提前、正数延后，每次 0.05 秒；字幕不会移出所在镜头。看成片时觉得字幕比声音早或晚，就在这里调整。")}</p>
    <details className="mv-caption-shots"><summary>{t("逐镜调整断行和时间")}</summary>
      <p className="mv-hint">{t("每行是一条字幕，可以拆分或合并行、增减标点。")}</p>
      <ol>{draft.storyboard.map((shot, index) => {
        const entry = marketingShotCaption(draft, index, shot.script);
        const auto = captionLines(shot.script, maxCells);
        const lines = entry?.lines ?? auto;
        return <ShotCaption key={index} index={index} start={index ? ends[index - 1] : 0} end={ends[index]} lines={lines} auto={!entry?.lines}
          mismatch={!!entry?.lines && !marketingCaptionLinesMatch(shot.script, entry.lines)} offsetSec={entry?.offsetSec ?? 0} busy={busy}
          burned={burned?.filter(cue => cue.shot === index) ?? []}
          onLines={next => updateShot(index, { lines: next && !sameLines(next, auto) ? next : undefined })} onOffset={offsetSec => updateShot(index, { offsetSec })} />;
      })}</ol>
    </details>
  </fieldset>;
}

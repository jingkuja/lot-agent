import { useState } from "react";
import { planPresenterSegments, presenterCaptionErrors } from "@lot-agent/core/digital-presenter";
import { captionLayout, captionLines, marketingCaptionLinesMatch, marketingCaptionsValue, MarketingCaptionsSchema, marketingShotCaption, type MarketingCaptions } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { CAPTION_POSITIONS, CAPTION_SIZES, CaptionColorChoice, OffsetField, sameLines, ShotCaption, type CaptionUnitCopy } from "../marketing-video/CaptionSettings.js";
import type { Project } from "./api.js";

const SEGMENT_COPY: CaptionUnitCopy = { title: "第 {0} 段", aria: "第 {0} 段字幕", empty: "每段至少保留一行字幕。",
  mismatch: "字幕只能调整断行和标点。", offset: "本段提前或延后（秒）" };
const same = (a: MarketingCaptions | undefined, b: MarketingCaptions | undefined) => JSON.stringify(marketingCaptionsValue(a) ?? null) === JSON.stringify(marketingCaptionsValue(b) ?? null);

/** Captions of a made video: size, position, timing and line breaks. The words are the segments'
 * script; applying composes the kept clips again without the model. Remount per task. */
export function PresenterCaptions({ project, frame, busy, onApply }: {
  project: Project; frame: { width: number; height: number }; busy: boolean; onApply(captions: MarketingCaptions | undefined): void;
}) {
  const { t } = useI18n();
  const saved = project.draft.captions;
  const [captions, setCaptions] = useState<MarketingCaptions>(() => saved ?? MarketingCaptionsSchema.parse({}));
  const texts = planPresenterSegments(project.draft.script, project.draft.voice.speed).segments.map(segment => segment.text);
  const maxCells = captionLayout(frame.width, frame.height, captions).maxCells;
  const burned = project.output?.captions ?? [];
  const update = (next: Partial<MarketingCaptions>) => setCaptions(old => ({ ...old, ...next }));
  const updateSegment = (index: number, change: { lines?: string[]; offsetSec?: number }) => setCaptions(old => {
    const script = texts[index];
    const current = marketingShotCaption({ captions: old }, index, script);
    const entry = { script, offsetSec: current?.offsetSec ?? 0, ...(current?.lines ? { lines: current.lines } : {}), ...change };
    if (!entry.lines) delete entry.lines;
    return { ...old, shots: Array.from({ length: Math.max(old.shots.length, index + 1) }, (_, i) => i === index ? entry : old.shots[i] ?? null) };
  });
  const invalid = presenterCaptionErrors(captions, texts).length > 0;
  const choices = (label: string, values: { value: string; label: string }[], value: string, choose: (value: string) => void) =>
    <div className="mv-caption-choice"><span>{t(label)}</span>
      <div className="mv-choices" role="group" aria-label={t(label)}>{values.map(item =>
        <button key={item.value} type="button" disabled={busy} className={value === item.value ? "selected" : ""} aria-pressed={value === item.value} onClick={() => choose(item.value)}>{t(item.label)}</button>)}</div>
    </div>;
  return <fieldset className="mv-captions" aria-label={t("调整字幕")}>
    <legend>{t("调整字幕")}</legend>
    <p className="mv-hint">{t("字幕文字来自口播文案，这里只能调整断行、标点、出现时间、字号和位置。重新合成沿用已生成的片段，不调用模型、不产生费用。")}</p>
    <div className="mv-caption-row">
      {choices("字号", CAPTION_SIZES, captions.size, value => update({ size: value as MarketingCaptions["size"] }))}
      {choices("位置", CAPTION_POSITIONS, captions.position, value => update({ position: value as MarketingCaptions["position"] }))}
    </div>
    <CaptionColorChoice value={captions.color} busy={busy} onChoose={color => update({ color })} />
    {captions.position === "low" && frame.height > frame.width && <p className="mv-hint">{t("竖屏字幕靠下时，可能被短视频平台的按钮和标题遮挡。")}</p>}
    <div className="mv-caption-row">
      <OffsetField label="全片提前或延后（秒）" value={captions.offsetSec} busy={busy} onChange={offsetSec => update({ offsetSec })} />
      <button type="button" className="mv-primary" disabled={busy || invalid || same(captions, saved)} onClick={() => onApply(marketingCaptionsValue(captions))}>{t("重新合成成片")}</button>
      {!same(captions, saved) && <button type="button" disabled={busy} onClick={() => setCaptions(saved ?? MarketingCaptionsSchema.parse({}))}>{t("撤销修改")}</button>}
    </div>
    <p className="mv-hint">{t("负数提前、正数延后，每次 0.05 秒；字幕不会移出所在段落。看成片时觉得字幕比声音早或晚，就在这里调整。")}</p>
    <details className="mv-caption-shots"><summary>{t("逐段调整断行和时间")}</summary>
      <p className="mv-hint">{t("每行是一条字幕，可以拆分或合并行、增减标点。")}</p>
      <ol>{texts.map((text, index) => {
        const entry = marketingShotCaption({ captions }, index, text);
        const auto = captionLines(text, maxCells);
        return <ShotCaption key={index} index={index} lines={entry?.lines ?? auto} auto={!entry?.lines} copy={SEGMENT_COPY}
          mismatch={!!entry?.lines && !marketingCaptionLinesMatch(text, entry.lines)} offsetSec={entry?.offsetSec ?? 0} busy={busy}
          burned={burned.filter(cue => cue.shot === index)}
          onLines={next => updateSegment(index, { lines: next && !sameLines(next, auto) ? next : undefined })} onOffset={offsetSec => updateSegment(index, { offsetSec })} />;
      })}</ol>
    </details>
  </fieldset>;
}

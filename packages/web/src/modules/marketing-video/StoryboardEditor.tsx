import { useState } from "react";
import type { MarketingDraft, MarketingShot } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";

export function StoryboardEditor({ shots, presenter = "always", busy, readOnly = false, creation = false, compact = false, redo, onChange, onAi }: {
  shots: MarketingShot[];
  presenter?: MarketingDraft["presenter"];
  busy: boolean;
  readOnly?: boolean;
  creation?: boolean;
  /** Inside a panel that already shows the heading and totals. */
  compact?: boolean;
  /** A made video: the shots to redo. A shot with a reason (edited, no usable clip) stays chosen;
   * a note says what happens to an optional one that is left out. */
  redo?: { selected: boolean[]; reasons: (string | undefined)[]; notes?: (string | undefined)[]; onToggle(index: number): void;
    /** The clip each shot has now, watched before choosing to redo it. */
    clips?: (string | null | undefined)[] };
  onChange?: (shots: MarketingShot[]) => void;
  onAi?: (instruction: string, index?: number) => void;
}) {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const [target, setTarget] = useState("all");
  const fields = [{ key: "script", label: "分镜口播", max: 600 }, { key: "visual", label: "画面内容", max: 600 }, { key: "action", label: "人物与产品动作", max: 400 }, { key: "camera", label: "景别与镜头运动", max: 400 }] as const;
  const ends = shots.reduce<number[]>((times, shot) => [...times, (times.at(-1) ?? 0) + (shot.durationSec ?? 15)], []);
  return <div className="mv-storyboard">
    {!compact && <div className="mv-section-head"><h3>{t(readOnly || redo ? "制作分镜" : creation ? "生成分镜" : "确认分镜")}</h3><span>{t("{0} 个分镜 · 共 {1} 秒", [shots.length, ends.at(-1) ?? 0])}</span></div>}
    <p className="mv-hint">{t(redo ? "修改镜头内容或勾选「重新生成此镜」，只重新生成这些镜头并重新合成；其余镜头沿用已生成的片段，不再计费。镜数和每镜时长不可修改。"
      : readOnly ? "以下是本次制作使用的分镜。修改后需作为新视频重新生成。"
      : presenter === "mixed" ? "数字分身出现在部分镜头，请在画面内容中写明该镜是否有人物出镜。" : "数字分身将在每个镜头出镜，保持人物形象一致。")}</p>
    <div className="mv-shot-list">{shots.map((shot, index) => <article className={redo?.selected[index] ? "mv-shot mv-shot-redo" : "mv-shot"} key={index} aria-label={t("第 {0} 镜", [index + 1])}>
      <header><h4>{t("第 {0} 镜", [index + 1])}</h4><span>{index ? ends[index - 1] : 0}–{ends[index]}s · {t("{0} 秒", [shot.durationSec ?? 15])}</span></header>
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

/** A kept clip, loaded only once opened so a long storyboard does not fetch every video. */
function ShotClip({ url, index }: { url: string; index: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <details className="mv-shot-clip" onToggle={e => setOpen(e.currentTarget.open)}><summary>{t("查看本镜片段")}</summary>
    {open && <video controls preload="metadata" src={url} aria-label={t("第 {0} 镜片段", [index + 1])} />}</details>;
}

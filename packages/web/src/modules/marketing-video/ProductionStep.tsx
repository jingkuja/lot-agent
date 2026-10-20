import type { RefObject } from "react";
import type { MarketingDraft, MarketingSegment, MarketingShot, MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { StoryboardEditor } from "./StoryboardEditor.js";
import { Choices, MaterialField, type DraftForm, type MaterialHandlers } from "./StudioFields.js";

/** Step 3: voice, music, captions and format, then confirm the storyboard and generate. */
export function ProductionStep({ form, profile, handlers, referenceVideoStatus, parts, planError, blocker, blockerId, buttonLabel, storyboardPanel, onPickVoice, onStoryboard, onStoryboardAi, onEditCopy, onGenerate, onManualStoryboard }: {
  form: DraftForm; profile: MarketingVideoProfile; handlers: MaterialHandlers; referenceVideoStatus: string;
  /** Clips the current draft would be generated as. */
  parts: MarketingSegment[];
  planError: string;
  /** Why generation cannot start now, if anything. */
  blocker: string; blockerId: string; buttonLabel: string;
  storyboardPanel: RefObject<HTMLDivElement | null>;
  onPickVoice(): void; onStoryboard(shots: MarketingShot[]): void; onStoryboardAi(instruction: string, index?: number): void;
  onEditCopy(): void; onGenerate(): void; onManualStoryboard(): void;
}) {
  const { t } = useI18n();
  const { draft, busy, frozen, ready, field } = form;
  const hasBoard = !!draft.storyboard.length;
  return <>
    {draft.assets.video ? <p className="mv-hint" role="status">{referenceVideoStatus}</p> : <>
      <label className="mv-label">{t("旁白风格")}</label>
      <Choices form={form} label="旁白风格" values={["自然旁白", "温柔女声", "沉稳男声", "活力讲述"].map(value => ({ value, label: value }))} value={draft.voice} onChoose={value => field("voice", value)} />
      <button className="mv-soft" disabled={busy || frozen || !ready} onClick={onPickVoice}>{t("选择数字分身音色")}</button>
      <MaterialField form={form} slot="voice" label="上传音色样例（选填，2–15 秒）" accept="audio/mpeg,audio/wav" handlers={handlers} />
      <p className="mv-hint">{t("音色样例选填，可使用数字分身中的声音或自行上传；留空时按所选旁白风格使用模型原生配音，发布前请试听成片。")}</p>
    </>}
    <MaterialField form={form} slot="music" label="选择背景音乐（选填）" accept="audio/mpeg,audio/wav,audio/mp4" handlers={handlers} />
    {draft.assets.music && <label className="mv-field"><span>{t("背景音乐音量")}</span><input aria-label={t("背景音乐音量")} type="range" min="0" max="0.5" step="0.01" value={draft.musicVolume} disabled={busy} onChange={e => field("musicVolume", Number(e.target.value))} /></label>}
    <label className="mv-checkbox"><input type="checkbox" checked={draft.subtitles} disabled={busy} onChange={e => field("subtitles", e.target.checked)} />{t("添加字幕")}</label>
    <p className="mv-hint">{t("字幕由视频模型根据提示词生成，发布前请检查文字与音画是否一致。")}</p>
    <label className="mv-label">{t("画面比例")}</label>
    <Choices form={form} label="画面比例" values={["9:16", "16:9", "1:1"].map(value => ({ value, label: value }))} value={draft.ratio} onChoose={value => field("ratio", value as MarketingDraft["ratio"])} />
    <Choices form={form} label="视频质量" values={[{ value: "720p", label: "默认" }, { value: "1080p", label: "高清" }]} value={draft.quality} onChoose={value => field("quality", value as MarketingDraft["quality"])} />
    {profile.referenceMaxQuality && <p className="mv-hint">{t("使用人物、场景图片或参考视频时最高支持 720p。")}</p>}
    {!hasBoard && !!parts.length && <details className="mv-script-review"><summary>{t("查看自动分段（{0} 段）", [parts.length])}</summary>{parts.map(p => <p key={p.index}>{p.index + 1} · {p.durationSec}s<br />{p.script}</p>)}</details>}
    <p className="mv-hint">{t("目标 {0} 秒，分镜共 {1} 秒，分 {2} 段生成。", [draft.durationSec, parts.reduce((sum, part) => sum + part.durationSec, 0), parts.length])}</p>
    {hasBoard && <div ref={storyboardPanel} className="mv-storyboard-panel"><StoryboardEditor shots={draft.storyboard} busy={busy} onChange={onStoryboard} onAi={onStoryboardAi} /></div>}
    {!hasBoard && <p className="mv-hint">{t("先生成可编辑分镜，确认后再制作视频。")}</p>}
    {blocker && <div id={blockerId} role="alert"><p className="mv-error">{t(blocker)}</p>{planError && !hasBoard && <button disabled={busy || !ready} onClick={onEditCopy}>{t("修改文案或时长")}</button>}</div>}
    <button className="mv-primary mv-generate" disabled={busy || !!blocker} aria-describedby={blocker ? blockerId : undefined} onClick={onGenerate}>{t(buttonLabel)}</button>
    {!hasBoard && <button disabled={busy || !!blocker} onClick={onManualStoryboard}>{t("手动编排分镜")}</button>}
  </>;
}

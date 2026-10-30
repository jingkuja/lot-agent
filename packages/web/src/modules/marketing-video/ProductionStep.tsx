import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { MarketingNarrationSchema, marketingDraftProfile, marketingHdUnavailable, type MarketingDraft, type MarketingSegment, type MarketingShot,
  type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { voiceUploadLabel } from "./materials.js";
import type { GenerationCheck } from "./production-checks.js";
import { ShotOverview, StoryboardEditor, type StoryboardStructure } from "./StoryboardEditor.js";
import { Choices, DraftText, Hint, MaterialField, type DraftForm, type MaterialHandlers } from "./StudioFields.js";

/** How the narration is voiced: by the video model, or as the twin's own off-screen voice-over
 * (people on screen may move naturally but never deliver the lines to the lens).
 * Lip-synced presenters belong to the separate digital presenter agent. */
const VOICE_MODES = [
  { twin: false, title: "AI 配音", description: "视频模型生成出镜人物的语音，可用声音样例参考音色。" },
  { twin: true, title: "数字分身旁白", description: "用数字分身原声朗读文案，AI 生成画面演绎内容。" },
];

function VoiceModes({ form, available }: { form: DraftForm; available: boolean }) {
  const { t } = useI18n();
  const twin = !!form.draft.narration;
  return <div className="mv-voice-modes" role="group" aria-label={t("配音方式")}>
    {VOICE_MODES.map(mode => <button key={mode.title} type="button" className={mode.twin === twin ? "selected" : ""} aria-pressed={mode.twin === twin}
      disabled={(mode.twin && !available && !twin) || form.busy || form.frozen || !form.ready}
      onClick={() => { if (mode.twin !== twin) form.field("narration", mode.twin ? MarketingNarrationSchema.parse({}) : undefined); }}>
      <strong>{t(mode.title)}{mode.twin && !available && <em>{t("暂不可用")}</em>}</strong>
      <span>{t(mode.description)}</span>
    </button>)}
  </div>;
}

/** The twin voice, its pace and tone. Changing any of them needs new takes. `made`: shown
 * with a made video, where the takes are made when it is composed again. */
export function NarrationSettings({ form, onPickVoice, made = false }: { form: DraftForm; onPickVoice(): void; made?: boolean }) {
  const { t } = useI18n();
  const { draft, busy, frozen, ready, field } = form;
  const narration = draft.narration!;
  const set = (changes: Partial<typeof narration>) => field("narration", { ...narration, ...changes });
  const locked = busy || frozen || !ready;
  return <>
    <label className="mv-label">{t("旁白音色")}</label>
    <div className="mv-narration-voice">
      <span>{narration.twinItemId ? narration.voiceName || t("已选择数字分身音色") : t("尚未选择")}</span>
      <button className="mv-soft" disabled={locked} onClick={onPickVoice}>{t(narration.twinItemId ? "更换音色" : "从数字分身语音库选择")}</button>
    </div>
    <label className="mv-field"><span>{t("语速 {0}×", [narration.speed.toFixed(2)])}</span>
      <input aria-label={t("旁白语速")} type="range" min="0.8" max="1.25" step="0.05" value={narration.speed} disabled={locked}
        onChange={e => set({ speed: Number(e.target.value) })} />
    </label>
    <label className="mv-field"><span>{t("语气要求（可选）")}</span>
      <input value={narration.instructions} maxLength={200} disabled={locked} placeholder={t("例如：语气热情，语速稍快")} onChange={e => set({ instructions: e.target.value })} />
    </label>
    {!made && <Hint text="旁白用数字分身原声朗读，生成视频前逐镜试听。"
      more={[t("画面人物可以自然活动，但不会对着镜头念台词。"), t("字幕按确认文案在合成时加入，并按配音停顿切换。")]} />}
  </>;
}

/** Step 3: voice, music, captions, aspect ratio and picture quality. `keyArt`: a still of the current look exists. */
export function ProductionStep({ form, profile, handlers, referenceVideoStatus, narrationAvailable, keyArt, onPickVoice, onPickNarrationVoice }: {
  form: DraftForm; profile: MarketingVideoProfile; handlers: MaterialHandlers; referenceVideoStatus: string;
  /** Whether this server can synthesize twin narration. */
  narrationAvailable: boolean;
  keyArt: boolean;
  onPickVoice(): void; onPickNarrationVoice(): void;
}) {
  const { t } = useI18n();
  const { draft, busy, frozen, ready, field } = form;
  // 1080p switches the draft to its own model, so its limits decide whether 1080p can be chosen.
  const hdProfile = marketingDraftProfile({ ...draft, quality: "1080p" }, profile);
  const hdUnavailable = marketingHdUnavailable(draft, hdProfile, keyArt);
  return <>
    {draft.assets.video ? <p className="mv-hint" role="status">{referenceVideoStatus}</p> : <>
      <label className="mv-label">{t("配音方式")}</label>
      <VoiceModes form={form} available={narrationAvailable} />
      {draft.narration ? <NarrationSettings form={form} onPickVoice={onPickNarrationVoice} /> : <>
        <label className="mv-field"><span>{t("语气要求（可选）")}</span>
          <input value={draft.voice} maxLength={100} disabled={busy || frozen || !ready} placeholder={t("例如：语气热情，语速稍快")}
            onChange={e => field("voice", e.target.value)} />
        </label>
        <label className="mv-label">{t("音色参考（选填）")}</label>
        <button className="mv-soft" disabled={busy || frozen || !ready} onClick={onPickVoice}>{t("从数字分身语音库选择")}</button>
        <MaterialField form={form} slot="voice" label={voiceUploadLabel()} handlers={handlers} />
        <Hint text="声音样例只参考音色，成片声音与原声相近但不完全相同。"
          more={[t("模型按文案配音，不保证逐字照念。"), t("字幕按确认文案在合成时加入，成片后可以调整。"), t("发布前请试听成片。")]} />
      </>}
    </>}
    <MaterialField form={form} slot="music" label="选择背景音乐（选填）" handlers={handlers} />
    {draft.assets.music && <label className="mv-field"><span>{t("背景音乐音量")}</span>
      <input aria-label={t("背景音乐音量")} type="range" min="0" max="0.5" step="0.01" value={draft.musicVolume} disabled={busy}
        onChange={e => field("musicVolume", Number(e.target.value))} /></label>}
    <label className="mv-checkbox"><input type="checkbox" checked={draft.subtitles} disabled={busy} onChange={e => field("subtitles", e.target.checked)} />{t("添加字幕")}</label>
    <label className="mv-label">{t("画面比例")}</label>
    <Choices form={form} label="画面比例" values={["9:16", "16:9", "1:1"].map(value => ({ value, label: value }))} value={draft.ratio}
      onChoose={value => field("ratio", value as MarketingDraft["ratio"])} />
    <label className="mv-label">{t("画质")}</label>
    <Choices form={form} label="画质" values={[{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p", disabled: hdUnavailable }]}
      value={draft.quality} onChoose={value => field("quality", value as MarketingDraft["quality"])} />
    {hdProfile.referenceMaxQuality && <p className="mv-hint" role={hdUnavailable ? "note" : undefined}>{t("使用参考图片、动作参考视频或定妆图时，最高支持 720p。")}</p>}
    {draft.quality === "1080p" && <p className="mv-hint" role="note">{t("1080p 生成时间会变长，请耐心等待。")}</p>}
  </>;
}

/** The checks generating will run or warn about, shown above the generate button. */
function GenerationChecklist({ checks }: { checks: GenerationCheck[] }) {
  const { t } = useI18n();
  return <ul className="mv-checklist" aria-label={t("生成前检查")}>{checks.map(check => <li key={check.text} className={check.state}>{t(check.text, check.values)}</li>)}</ul>;
}

/** Step 4: confirm the storyboard, its key-art still and narration takes, check the text, then generate. */
export function ConfirmStep({ form, parts, planError, blocker, blockerId, buttonLabel, checks, storyboardPanel, reviewPanel, audioNotice, narrationPanel,
  keyArtPanel, history, structure, onStoryboard, onStoryboardAi, onEditCopy, onGenerate, onManualStoryboard }: {
  form: DraftForm;
  /** Clips the current draft would be generated as. */
  parts: MarketingSegment[];
  planError: string;
  /** Why generation cannot start now, if anything. */
  blocker: string; blockerId: string; buttonLabel: string;
  checks: GenerationCheck[];
  storyboardPanel: RefObject<HTMLDivElement | null>;
  /** The copy check, shown last before generating. */
  reviewPanel: ReactNode;
  /** Shown when the reference video changed what the board was planned for. */
  audioNotice: ReactNode;
  /** Per-shot takes, shown with the confirmed board in twin narration mode. */
  narrationPanel: ReactNode;
  /** The shared key-art still, shown with the confirmed board. */
  keyArtPanel: ReactNode;
  /** Earlier copy and storyboard versions to restore. */
  history: ReactNode;
  /** Limits for changing shot times and order. */
  structure: StoryboardStructure;
  onStoryboard(shots: MarketingShot[]): void; onStoryboardAi(instruction: string, index?: number): void;
  onEditCopy(): void; onGenerate(): void; onManualStoryboard(): void;
}) {
  const { t } = useI18n();
  const { draft, busy, ready } = form;
  const hasBoard = !!draft.storyboard.length;
  // An overview first; the editor opens by itself only for a board just created here.
  const [editing, setEditing] = useState(false);
  const hadBoard = useRef(hasBoard);
  useEffect(() => {
    if (hasBoard && !hadBoard.current) setEditing(true);
    hadBoard.current = hasBoard;
  }, [hasBoard]);
  const total = draft.storyboard.reduce((sum, shot) => sum + (shot.durationSec ?? 15), 0);
  // Without a plan the numbers would read 0 seconds in 0 clips; the error below says why.
  const tally = !planError && <p className="mv-hint">{t("目标 {0} 秒，分镜共 {1} 秒，分 {2} 段生成。",
    [draft.durationSec, parts.reduce((sum, part) => sum + part.durationSec, 0), parts.length])}</p>;
  return <>
    {hasBoard ? <div ref={storyboardPanel} className="mv-storyboard-panel">
      <div className="mv-section-head"><h3>{t("确认分镜")}</h3><span>{t("{0} 个分镜 · 共 {1} 秒", [draft.storyboard.length, total])}</span></div>
      {tally}
      {audioNotice}
      <ShotOverview shots={draft.storyboard} />
      <details className="mv-storyboard-edit" open={editing} onToggle={e => { if (e.target === e.currentTarget) setEditing(e.currentTarget.open); }}>
        <summary>{t("修改分镜")}</summary>
        <DraftText form={form} name="continuity" label="统一人物、产品与场景设定" max={400} rows={3} placeholder="每段视频都会带上这段描述，用于保持人物、服装、产品和场景一致。" />
        <StoryboardEditor compact presenter={draft.presenter} shots={draft.storyboard} busy={busy} structure={structure}
          onChange={onStoryboard} onAi={onStoryboardAi} />
      </details>
      {history}
      {keyArtPanel}
      {narrationPanel}
    </div> : <>
      {!!parts.length && <details className="mv-script-review"><summary>{t("查看自动分段（{0} 段）", [parts.length])}</summary>
        {parts.map(p => <p key={p.index}>{p.index + 1} · {p.durationSec}s<br />{p.script}</p>)}</details>}
      {tally}
      {history}
    </>}
    {reviewPanel}
    {hasBoard && <GenerationChecklist checks={checks} />}
    {blocker && <div id={blockerId} role="alert"><p className="mv-error">{t(blocker)}</p>
      {planError && <button disabled={busy || !ready} onClick={onEditCopy}>{t("修改文案或时长")}</button>}</div>}
    <button className="mv-primary mv-generate" disabled={busy || !!blocker} aria-describedby={blocker ? blockerId : undefined} onClick={onGenerate}>{t(buttonLabel)}</button>
    {!hasBoard && <button disabled={busy || !!blocker} onClick={onManualStoryboard}>{t("手动编排分镜")}</button>}
  </>;
}

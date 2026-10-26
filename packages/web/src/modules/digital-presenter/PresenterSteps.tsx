import { useEffect, useRef, useState, type ReactNode } from "react";
import { planPresenterSegments, presenterTrackMs, PRESENTER_SEGMENT_MAX_MS, type PresenterDraft, type PresenterReview, type PresenterReviewIssue, type PresenterTake } from "@lot-agent/core/digital-presenter";
import { useI18n } from "../../i18n/index.js";
import { takeAudio, type Material, type MaterialSlot, type Project } from "./api.js";

/** What every step edits: the draft, and whether it may change now. */
export interface PresenterForm {
  draft: PresenterDraft; busy: boolean; locked: boolean;
  set<K extends keyof PresenterDraft>(key: K, value: PresenterDraft[K]): void;
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** Step 1: topic, optional AI writing, the spoken script and how it is split into takes. */
export function ScriptStep({ form, onWrite, reviewPanel }: { form: PresenterForm; onWrite(): void; reviewPanel: ReactNode }) {
  const { t } = useI18n();
  const { draft, busy, locked, set } = form;
  const plan = planPresenterSegments(draft.script, draft.voice.speed);
  const estimate = plan.segments.reduce((sum, segment) => sum + segment.estimateSec, 0);
  return <>
    <label className="mv-field"><span>{t("口播主题")}</span>
      <textarea rows={3} maxLength={800} value={draft.topic} disabled={locked} placeholder={t("例如：介绍门店的招牌套餐和到店优惠，语气亲切")} onChange={e => set("topic", e.target.value)} />
    </label>
    <label className="mv-field"><span>{t("目标时长 {0} 秒", [draft.durationSec])}</span>
      <input aria-label={t("目标时长")} type="range" min="10" max="90" step="5" value={draft.durationSec} disabled={locked} onChange={e => set("durationSec", Number(e.target.value))} />
    </label>
    <button className="mv-soft" disabled={busy || locked || !draft.topic.trim()} onClick={onWrite}>{t(draft.script.trim() ? "重新生成口播文案" : "AI 生成口播文案")}</button>
    <label className="mv-field"><span>{t("口播文案")}</span>
      <textarea rows={8} maxLength={2000} value={draft.script} disabled={locked} placeholder={t("可直接粘贴已有文案。用句号分句，每句尽量简短。")} onChange={e => set("script", e.target.value)} />
    </label>
    {plan.error && draft.script.trim() ? <p className="mv-error" role="alert">{t(plan.error)}</p>
      : !!plan.segments.length && <details className="mv-script-review"><summary>{t("按句分为 {0} 段配音，预计约 {1} 秒", [plan.segments.length, Math.round(estimate)])}</summary>
        {plan.segments.map(segment => <p key={segment.index}>{segment.index + 1} · ~{Math.round(segment.estimateSec)}s<br />{segment.text}</p>)}
      </details>}
    {reviewPanel}
  </>;
}

/** One finding of the check: apply its suggestion where the excerpt occurs once, or edit the whole script. */
function ReviewIssue({ issue, script, busy, onApply }: { issue: PresenterReviewIssue; script: string; busy: boolean; onApply(script: string): void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(script);
  // Only an excerpt found exactly once can be replaced without guessing which occurrence is meant.
  const located = !!issue.text && script.split(issue.text).length === 2;
  const suggested = located && issue.suggestion && issue.suggestion !== issue.text ? script.replace(issue.text, issue.suggestion) : null;
  return <article className="mv-review-issue">
    <header><strong>{t("口播文案")}</strong><span>{t(issue.severity === "reject" ? "请修改风险内容" : "有内容需要核实")}</span></header>
    <blockquote>{issue.text}</blockquote>
    <p>{t("风险原因")}：{issue.reason}</p>
    <p>{t("修改建议")}：{issue.suggestion || t("删除这段风险内容")}</p>
    {editing ? <div className="mv-review-edit">
      <label className="mv-field"><span>{t("修改内容")} · {t("口播文案")}</span><textarea autoFocus rows={5} maxLength={2000} value={value} disabled={busy} onChange={event => setValue(event.target.value)} /></label>
      <div className="mv-review-actions">
        <button disabled={busy || !value.trim() || value === script} onClick={() => onApply(value)}>{t("保存修改")}</button>
        <button disabled={busy} onClick={() => setEditing(false)}>{t("取消")}</button>
      </div>
    </div> : <div className="mv-review-actions">
      <button disabled={busy || !suggested} onClick={() => { if (suggested) onApply(suggested); }}>{t("一键修改")}</button>
      <button disabled={busy} onClick={() => { setValue(script); setEditing(true); }}>{t("自己修改")}</button>
    </div>}
    {!located && !editing && <p className="mv-hint">{t("此条建议需要结合上下文修改，请选择自己修改。")}</p>}
  </article>;
}

/** The marketing copy check, applied to the spoken script. Fixes only save the script; a `stale`
 * check is the last one before those edits and lists the findings still in the text. */
export function ReviewSection({ review, script, busy, onReview, onApply, stale = false }: { review?: PresenterReview; script: string; busy: boolean; onReview(): void; onApply(script: string): void; stale?: boolean }) {
  const { t } = useI18n();
  const issues = review && stale ? review.issues.filter(issue => script.includes(issue.text)) : review?.issues ?? [];
  const verdict = !stale ? review?.verdict : issues.some(issue => issue.severity === "reject") ? "reject" : issues.length ? "suspect" : "";
  return <section className="mv-review-section" aria-label={t("文案检查")}>
    <div className="mv-section-head"><h3>{t("文案检查")}</h3><button disabled={busy} onClick={onReview}>{t("检查当前文案")}</button></div>
    {review ? <div className={`mv-review${verdict ? ` mv-review-${verdict}` : ""}`}>
      <strong role="status">{t(stale ? "内容已修改，请点击「检查当前文案」重新检查。" : ({ pass: "文案检查完成，未发现明显风险", suspect: "有内容需要核实", reject: "请修改风险内容" })[review.verdict])}</strong>
      {issues.map((issue, index) => <ReviewIssue key={`${review.reviewedAt}:${index}:${issue.text}`} issue={issue} script={script} busy={busy} onApply={onApply} />)}
      {!stale && !!review.dropped && <p className="mv-hint">{t("另有 {0} 条检查结果无法在文案中定位，已忽略；请人工复核全文。", [review.dropped])}</p>}
    </div> : <p className="mv-hint" role="status">{t("生成视频前需完成文案检查；修改文案后需重新检查。")}</p>}
  </section>;
}

const MODES = [
  { mode: "image", title: "以图生成", description: "一张人物肖像，由原声驱动说话、表情和动作。适合没有拍摄素材时快速出片。" },
  { mode: "video", title: "以视频生成", description: "一段本人口播底片，保留真实动作和场景，只替换口型和台词。" },
] as const;

function MaterialPreview({ material, label, onRemove, locked }: { material?: Material; label: string; onRemove(): void; locked: boolean }) {
  const { t } = useI18n();
  if (!material) return null;
  return <div className="mv-asset-preview">
    {material.mime.startsWith("video/") ? <video controls preload="metadata" src={material.url} aria-label={t(label)} /> : <img src={material.url} alt={t(label)} />}
    <span>{material.name}</span>
    <button disabled={locked} onClick={onRemove}>{t("移除")}</button>
  </div>;
}

/** Step 2: how the presenter is made, its picture or footage, and the cloned voice. */
export function PresenterStep({ form, materials, speechAvailable, onPickTwin, onUpload, onPickVoice }: {
  form: PresenterForm; materials: Partial<Record<MaterialSlot, Material>>; speechAvailable: boolean;
  onPickTwin(slot: "portrait" | "faceReference"): void; onUpload(slot: MaterialSlot, file: File): void; onPickVoice(): void;
}) {
  const { t } = useI18n();
  const { draft, locked, set } = form;
  const upload = (slot: MaterialSlot, label: string, accept: string) => <label className="mv-upload-button">{t(label)}
    <input aria-label={t(label)} type="file" accept={accept} disabled={locked} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) onUpload(slot, file); }} />
  </label>;
  const voice = draft.voice;
  return <>
    <label className="mv-label">{t("生成方式")}</label>
    <div className="mv-voice-modes" role="group" aria-label={t("生成方式")}>
      {MODES.map(item => <button key={item.mode} type="button" className={item.mode === draft.mode ? "selected" : ""} aria-pressed={item.mode === draft.mode} disabled={locked}
        onClick={() => set("mode", item.mode)}><strong>{t(item.title)}</strong><span>{t(item.description)}</span></button>)}
    </div>
    {draft.mode === "image" ? <>
      <label className="mv-label">{t("人物肖像")}</label>
      <div className="mv-upload">
        <button className="mv-upload-button" disabled={locked} onClick={() => onPickTwin("portrait")}>{t("从数字分身肖像库选择")}</button>
        {upload("portrait", "上传肖像", "image/jpeg,image/png,image/webp")}
        <MaterialPreview material={materials.portrait} label="人物肖像" locked={locked} onRemove={() => set("portrait", undefined)} />
      </div>
      <p className="mv-hint">{t("请使用单人、正脸、五官清晰、光线均匀的半身或近景照片，宽高均不小于 400 像素。")}</p>
      <label className="mv-label">{t("画面比例")}</label>
      <div className="mv-choices" role="group" aria-label={t("画面比例")}>{(["9:16", "16:9", "1:1"] as const).map(ratio =>
        <button key={ratio} className={draft.ratio === ratio ? "selected" : ""} aria-pressed={draft.ratio === ratio} disabled={locked} onClick={() => set("ratio", ratio)}>{ratio}</button>)}</div>
      <label className="mv-label">{t("清晰度")}</label>
      <div className="mv-choices" role="group" aria-label={t("清晰度")}>{(["720P", "480P"] as const).map(value =>
        <button key={value} className={draft.resolution === value ? "selected" : ""} aria-pressed={draft.resolution === value} disabled={locked} onClick={() => set("resolution", value)}>{value}</button>)}</div>
      <p className="mv-hint">{t("肖像会按所选比例居中裁切。每段配音单独生成一个片段，段与段之间画面会轻微切换。")}</p>
    </> : <>
      <label className="mv-label">{t("口播底片")}</label>
      <div className="mv-upload">
        {upload("baseVideo", "上传口播底片", "video/mp4,video/quicktime")}
        <MaterialPreview material={materials.baseVideo} label="口播底片" locked={locked} onRemove={() => set("baseVideo", undefined)} />
      </div>
      <p className="mv-hint">{t("MP4 或 MOV，最大 150 MB。人物正面近景、少侧脸，时长需不短于配音（超出部分会裁掉），原声会被替换。")}</p>
      <label className="mv-label">{t("目标人脸（选填）")}</label>
      <div className="mv-upload">
        <button className="mv-upload-button" disabled={locked} onClick={() => onPickTwin("faceReference")}>{t("从数字分身肖像库选择")}</button>
        {upload("faceReference", "上传人脸照片", "image/jpeg,image/png,image/webp")}
        <MaterialPreview material={materials.faceReference} label="目标人脸" locked={locked} onRemove={() => set("faceReference", undefined)} />
      </div>
      <p className="mv-hint">{t("画面里有多个人时，指定需要对口型的人；单人底片无需选择。")}</p>
    </>}
    <label className="mv-label">{t("数字分身音色")}</label>
    <div className="mv-narration-voice">
      <span>{voice.twinItemId ? voice.voiceName || t("已选择数字分身音色") : t("尚未选择")}</span>
      <button className="mv-soft" disabled={locked || !speechAvailable} onClick={onPickVoice}>{t(voice.twinItemId ? "更换音色" : "从数字分身语音库选择")}</button>
    </div>
    {!speechAvailable && <p className="mv-error">{t("数字分身配音服务未启用。")}</p>}
    <label className="mv-field"><span>{t("语速 {0}×", [voice.speed.toFixed(2)])}</span>
      <input aria-label={t("语速")} type="range" min="0.8" max="1.25" step="0.05" value={voice.speed} disabled={locked} onChange={e => set("voice", { ...voice, speed: Number(e.target.value) })} />
    </label>
    <label className="mv-field"><span>{t("语气要求（可选）")}</span>
      <input value={voice.instructions} maxLength={200} disabled={locked} placeholder={t("例如：语气热情，语速稍快")} onChange={e => set("voice", { ...voice, instructions: e.target.value })} />
    </label>
    <label className="mv-checkbox"><input type="checkbox" checked={draft.consent} disabled={locked} onChange={e => set("consent", e.target.checked)} />
      {t("我确认肖像、底片和声音均为本人，或已获得本人授权用于生成视频。")}</label>
  </>;
}

/** Listening is free: the saved take is read back, never synthesized again. */
function TakePlayer({ projectId, slot, durationMs }: { projectId: string; slot: number; durationMs: number }) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { setUrl(""); setError(""); }, [projectId, slot, durationMs]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => () => abort.current?.abort(), []);
  async function load() {
    const controller = new AbortController(); abort.current?.abort(); abort.current = controller;
    setLoading(true); setError("");
    try {
      const blob = await takeAudio(projectId, slot, controller.signal);
      if (!controller.signal.aborted) setUrl(URL.createObjectURL(blob));
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "配音加载失败，请重试。"); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  if (url) return <audio src={url} controls autoPlay aria-label={t("第 {0} 段配音试听", [slot + 1])} />;
  return <>
    <button type="button" disabled={loading} onClick={() => void load()}>{t(loading ? "正在加载…" : "试听")}</button>
    {error && <span className="mv-narration-error" role="alert">{t(error)}</span>}
  </>;
}

/** Step 3: one take per segment in the cloned voice; listen, redo, then generate. */
export function TakesStep({ form, project, takes, blocker, onSynthesize, onGenerate }: {
  form: PresenterForm; project?: Project; takes: PresenterTake[] | null; blocker: string;
  onSynthesize(slots?: number[]): void; onGenerate(): void;
}) {
  const { t } = useI18n();
  const { draft, busy } = form;
  const plan = planPresenterSegments(draft.script, draft.voice.speed);
  const missing = !takes || takes.some(take => take.status === "missing");
  const durations = takes?.flatMap(take => take.durationMs === undefined ? [] : [take.durationMs]) ?? [];
  const complete = !!takes?.length && durations.length === takes.length;
  const status = (take?: PresenterTake) => !take || take.status === "missing" ? "未生成" : take.status === "running" ? "正在合成" : take.status === "failed" ? "合成失败" : "";
  return <>
    <section className="mv-narration" aria-label={t("原声配音")}>
      <div className="mv-section-head"><h3>{t("原声配音")}</h3>
        <button className="mv-soft" disabled={busy || !project || !missing || !draft.voice.twinItemId || !!plan.error} onClick={() => onSynthesize()}>{t(takes?.some(take => take.status !== "missing") ? "生成缺少的配音" : "生成配音")}</button>
      </div>
      <p className="mv-hint">{t("按句段用数字分身原声合成并保存，生成视频前请逐段试听。修改文案、音色、语速或语气后需重新生成；每次合成由模型账号计费。")}</p>
      <ol className="mv-narration-list">{plan.segments.map((segment, i) => {
        const take = takes?.[i];
        const long = draft.mode === "image" && take?.durationMs !== undefined && take.durationMs >= PRESENTER_SEGMENT_MAX_MS;
        return <li key={i} className={long ? "mv-narration-long" : ""}>
          <span>{t("第 {0} 段", [i + 1])}</span>
          <p className="dp-take-text">{segment.text}</p>
          <small>{take?.durationMs !== undefined ? t("配音 {0} 秒", [seconds(take.durationMs)]) + (long ? ` · ${t("超过 19.5 秒，请拆分")}` : "") : t(status(take))}</small>
          <div className="mv-narration-actions">
            {take?.durationMs !== undefined && project && <TakePlayer projectId={project.id} slot={i} durationMs={take.durationMs} />}
            {(take?.status === "succeeded" || take?.status === "failed") && <button type="button" disabled={busy} onClick={() => onSynthesize([i])}>{t("重新生成")}</button>}
          </div>
        </li>;
      })}</ol>
      {complete && <p className="mv-hint">{t("配音总长 {0} 秒，成片时长与配音一致。", [seconds(presenterTrackMs(durations))])}</p>}
    </section>
    <label className="mv-checkbox"><input type="checkbox" checked={draft.subtitles} disabled={form.locked} onChange={e => form.set("subtitles", e.target.checked)} />{t("添加字幕")}</label>
    {draft.subtitles && <p className="mv-hint">{t("字幕按口播文案在合成时加入，并按配音停顿切换。")}</p>}
    {blocker && <p className="mv-error" role="alert">{t(blocker)}</p>}
    <button className="mv-primary mv-generate" disabled={busy || !!blocker} onClick={onGenerate}>{t("生成主播视频")}</button>
    <p className="mv-hint">{t(draft.mode === "image" ? "以图生成按片段秒数计费，每段约需 5–10 分钟，多段会排队生成。" : "以视频生成按成片秒数计费，通常需要 5–15 分钟。")}</p>
  </>;
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type PickedFile, type VideoPublication } from "../../api/client.js";
import type { VideoSettings } from "../../components/MediaSettings.js";
import { useI18n } from "../../i18n/index.js";
import { pickVideoQuality } from "../../lib/video-settings.js";
import { DigitalTwinPicker } from "../digital-twin/DigitalTwinPanel.js";
import { validateTwinFile } from "../digital-twin/media.js";
import { BACKGROUNDS, DIRECTIONS, MUSIC, STEPS, VOICES, MARKETING_VIDEO_QUALITIES, buildSubmission, createDraft, type Draft, type DraftFiles } from "./draft.js";
import "./marketing-video.css";

interface Props {
  onSubmit: (content: string, files: PickedFile[], settings: VideoSettings, publication: VideoPublication) => void | Promise<void>;
  onDraftChange?: (dirty: boolean) => void;
  onNewVideo?: () => void;
  busy: boolean;
  hasMessages: boolean;
  publication?: unknown;
  children: ReactNode;
}

function AssetPreview({ file, label }: { file?: File; label: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file) { setUrl(""); return; }
    const next = URL.createObjectURL(file); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  if (!file || !url) return null;
  return <div className="mv-asset-preview">{file.type.startsWith("audio/") ? <audio src={url} controls aria-label={label} /> : <img src={url} alt={label} />}<span>{file.name}</span></div>;
}

export function MarketingVideoStudio({ onSubmit, onDraftChange, onNewVideo, busy, hasMessages, publication, children }: Props) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState(createDraft);
  const [assets, setAssets] = useState<DraftFiles>({});
  const [step, setStep] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [writing, setWriting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [twinOpen, setTwinOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const mounted = useRef(true);
  const copyAbort = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const qualities = MARKETING_VIDEO_QUALITIES;
  const quality = pickVideoQuality(qualities, draft.quality);
  const locked = busy || writing || checking || submitting;
  const finalStep = STEPS.length - 1;
  const rawPublication = publication && typeof publication === "object" ? publication as Record<string, unknown> : {};
  const savedPublication = {
    copy: typeof rawPublication.copy === "string" ? rawPublication.copy : "",
    tags: typeof rawPublication.tags === "string" ? rawPublication.tags : "",
  };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; copyAbort.current?.abort(); }; }, []);
  useEffect(() => { onDraftChange?.(!hasMessages && (dirty || writing || checking)); return () => onDraftChange?.(false); }, [dirty, writing, checking, hasMessages, onDraftChange]);
  useEffect(() => { heading.current?.focus(); navigation.current?.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "center" }); }, [step]);

  function field<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft((old) => ({ ...old, [key]: value })); setDirty(true); setError(""); }
  function removeAsset(key: keyof DraftFiles) { setAssets((old) => ({ ...old, [key]: undefined })); setDirty(true); }
  async function selectAsset(file: File, key: keyof DraftFiles) {
    if (locked || lock.current) throw new Error(t("正在处理素材…"));
    lock.current = true; setChecking(true);
    try {
      await validateTwinFile(file, key === "voice" ? "voice" : "portrait");
      if (!mounted.current) return;
      setAssets((old) => ({ ...old, [key]: file })); setDirty(true); setError("");
      if (key === "voice" && draft.voice === "无配音") field("voice", VOICES[0]);
    } finally { lock.current = false; if (mounted.current) setChecking(false); }
  }
  function choices(label: string, options: readonly string[], current: string, choose: (value: string) => void, scene = false) {
    return <div className={`mv-choices${scene ? " mv-scenes" : ""}`} role="group" aria-label={t(label)}>{options.map((option, index) => <button type="button" key={option} className={option === current ? "selected" : ""} aria-pressed={option === current} disabled={locked} onClick={() => choose(option)}>
      {scene && <span className={`mv-scene mv-scene-${index}`} aria-hidden><i /><i /><i /></span>}{t(option)}
    </button>)}</div>;
  }
  function textField(key: "topic" | "script" | "mainTitle" | "subtitle" | "publishTitle" | "tags" | "backgroundDetail", label: string, limit: number, placeholder?: string) {
    return <label className="mv-field"><span>{t(label)}</span>{["topic", "script", "backgroundDetail"].includes(key)
      ? <textarea value={draft[key]} maxLength={limit} placeholder={placeholder ? t(placeholder) : undefined} disabled={locked} onChange={(e) => field(key, e.target.value)} rows={key === "script" ? 6 : 3} />
      : <input value={draft[key]} maxLength={limit} disabled={locked} onChange={(e) => field(key, e.target.value)} />}</label>;
  }
  function imageUpload(key: "background" | "cover", label: string) {
    return <div className="mv-upload"><label className="mv-upload-button">{t(label)}<input type="file" aria-label={t(label)} accept="image/jpeg,image/png,image/webp" disabled={locked} onChange={(e) => {
      const file = e.target.files?.[0]; e.target.value = "";
      if (file) void selectAsset(file, key).catch((e) => { if (mounted.current) setError(e instanceof Error ? e.message : "操作失败，请重试。"); });
    }} /></label><AssetPreview file={assets[key]} label={t(label)} />{assets[key] && <button type="button" disabled={locked} onClick={() => removeAsset(key)}>{t("移除")}</button>}</div>;
  }
  function go(next: number) {
    if (locked) return;
    if (next > 0 && !draft.script.trim()) { setError("请先填写或生成视频文案。"); return; }
    if (next > 4 && draft.background === "自定义背景" && !draft.backgroundDetail.trim() && !assets.background) { setError("请描述自定义背景或上传背景图片。"); setStep(4); return; }
    setError(""); setStep(next);
  }
  async function writeCopy() {
    if (locked || lock.current) return;
    if (!draft.topic.trim()) { setError("请先填写创作主题。"); return; }
    lock.current = true; setWriting(true); setError("");
    const abort = new AbortController(); copyAbort.current = abort;
    try {
      const topic = `${t(draft.direction)} · ${draft.durationSec}s\n${draft.topic.trim()}\nOutput language: ${locale === "zh" ? "Chinese" : locale === "en" ? "English" : "Indonesian"}.`;
      const copy = await api.videoCopy(topic, abort.signal);
      if (mounted.current && !abort.signal.aborted) { setDraft((old) => ({ ...old, ...copy })); setDirty(true); }
    } catch { if (mounted.current && !abort.signal.aborted) setError("文案生成失败，请重试或直接填写。"); }
    finally { lock.current = false; if (mounted.current) setWriting(false); }
  }
  async function submit() {
    if (locked || lock.current || hasMessages) return;
    if (!draft.script.trim()) { setStep(0); setError("请先填写或生成视频文案。"); return; }
    lock.current = true; setSubmitting(true); setError("");
    const value = buildSubmission(draft, assets, t);
    try { await onSubmit(value.prompt, value.files, value.settings, { copy: draft.publishTitle, tags: draft.tags }); }
    catch { if (mounted.current) { setError("提交失败，请检查网络后重试。"); setSubmitting(false); } }
    finally { lock.current = false; }
  }
  async function copyPublication() {
    try { await navigator.clipboard.writeText([savedPublication?.copy, savedPublication?.tags].filter((value) => typeof value === "string").join("\n")); setNotice("已复制"); }
    catch { setNotice("复制失败，请选中文字手动复制。"); }
  }

  return <div className="mv-scroll"><div className="mv-studio">
    <header className="mv-heading"><div><span className="mv-eyebrow">{t("营销影像")}</span><h1>{t("把店铺与品牌，讲给更多人。")}</h1><p>{t("从文案到成片，一步一步完成你的营销视频。")}</p></div><span className="mv-heading-mark" aria-hidden>▶</span></header>
    {hasMessages ? <section className="mv-card mv-results"><div className="mv-section-head"><h2>{t("生成结果")}</h2><button type="button" disabled={busy} onClick={onNewVideo}>{t("开始新视频")}</button></div>
      {children}
      {(savedPublication?.copy || savedPublication?.tags) && <div className="mv-publication"><h3>{t("发布文案")}</h3><p>{savedPublication.copy}</p><p>{savedPublication.tags}</p><button type="button" onClick={() => void copyPublication()}>{t("复制发布文案")}</button><span role="status">{t(notice)}</span></div>}
    </section> : <>
      <nav ref={navigation} className="mv-steps" aria-label={t("视频创作步骤")}>{STEPS.map((label, index) => <button key={label} type="button" className={index === step ? "active" : index < step ? "done" : ""} aria-current={index === step ? "step" : undefined} disabled={locked} onClick={() => go(index)}><span>{index < step ? "✓" : index + 1}</span>{t(label)}</button>)}</nav>
      <section className="mv-card" aria-labelledby="mv-step-heading"><div className="mv-section-head"><h2 id="mv-step-heading" tabIndex={-1} ref={heading}>{t(STEPS[step])}</h2><span>{step + 1} / {STEPS.length}</span></div>
        {step === 0 && <>
          <div className="mv-directions">{DIRECTIONS.map((direction, index) => <button type="button" key={direction} aria-pressed={draft.direction === direction} className={draft.direction === direction ? "selected" : ""} disabled={locked} onClick={() => { field("direction", direction); field("background", index ? "简约演播室" : "真实店铺"); }}><span aria-hidden>{index ? "◉" : "⌂"}</span><strong>{t(direction)}</strong><small>{t(index ? "主播出镜 · 品牌卖点 · 宣传演讲" : "店铺环境 · 特色产品 · 到店邀请")}</small></button>)}</div>
          {textField("topic", "这次想拍什么", 700, draft.direction === DIRECTIONS[0] ? "填写店名、店铺特色、目标顾客和到店理由…" : "填写主播身份、品牌卖点、目标受众和行动邀请…")}
          <button type="button" className="mv-soft" disabled={locked || !draft.topic.trim()} onClick={() => void writeCopy()}>{t(writing ? "正在生成文案…" : draft.script ? "重新生成文案与标题" : "智能生成文案与标题")} ✧</button>
          {textField("script", "视频文案 / 分镜", 4000, "也可以直接填写镜头、动作和旁白…")}
        </>}
        {step === 1 && <><div className="mv-columns">{textField("mainTitle", "封面主标题", 40)}{textField("subtitle", "封面副标题", 60)}</div>{textField("publishTitle", "视频发布标题", 100)}{textField("tags", "短视频检索标签", 160)}<p className="mv-hint">{t("发布标题和标签随作品保存，不写入视频画面。")}</p></>}
        {step === 2 && <><p className="mv-hint">{t("选择个人肖像和声音作为参考，也可以跳过，让画面聚焦店铺或产品。")}</p><button type="button" className="mv-soft" disabled={locked} onClick={() => setTwinOpen(true)}>{t("选择数字分身素材")}</button><div className="mv-columns">{(["portrait", "voice"] as const).map((kind) => <div className="mv-twin" key={kind}><h3>{t(kind === "portrait" ? "个人肖像库" : "个人语音库")}</h3><AssetPreview file={assets[kind]} label={t(kind === "portrait" ? "肖像预览" : "声音试听")} />{assets[kind] ? <button type="button" disabled={locked} onClick={() => removeAsset(kind)}>{t("移除")}</button> : <p className="mv-hint">{t("未选择")}</p>}</div>)}</div><p className="mv-hint">{t("音色与肖像还原效果，以及真人肖像是否可用，取决于所选模型。")}</p></>}
        {step === 3 && <><label className="mv-label">{t("旁白风格")}</label>{choices("旁白风格", assets.voice ? VOICES.filter((v) => v !== "无配音") : VOICES, draft.voice, (v) => field("voice", v))}{assets.voice && <p className="mv-hint">{t("已选择个人声音，将优先参考该音色。")}</p>}<p className="mv-hint">{t("声音随视频一起生成，发布前请试听。")}</p></>}
        {step === 4 && <>{choices("视频背景", BACKGROUNDS, draft.background, (v) => field("background", v), true)}{textField("backgroundDetail", "背景补充描述", 600, "例如：木质吧台、暖色灯光，保留店铺招牌…")}{imageUpload("background", "上传背景图片（选填）")}<p className="mv-hint">{t("背景图用于场景参考，可与数字分身肖像同时使用。")}</p></>}
        {step === 5 && <><label className="mv-label">{t("画面比例")}</label>{choices("画面比例", ["9:16", "16:9", "1:1"], draft.ratio, (v) => field("ratio", v))}<label className="mv-label">{t("视频质量")}</label>{choices("视频质量", qualities.map((q) => q.label), quality.label, (v) => field("quality", qualities.find((q) => q.label === v)!.short))}<label className="mv-field" htmlFor="mv-duration"><span>{t("视频时长")} <output>{t("{0} 秒", [draft.durationSec])}</output></span><input id="mv-duration" type="range" min={4} max={15} step={1} value={draft.durationSec} disabled={locked} onChange={(e) => field("durationSec", Number(e.target.value))} /></label><p className="mv-hint">{t("适合短片或演讲片段，较长文案请精简后生成。")}</p></>}
        {step === 6 && <><label className="mv-label">{t("背景音乐")}</label>{choices("背景音乐", MUSIC, draft.bgm, (v) => field("bgm", v))}<label className="mv-checkbox"><input type="checkbox" checked={draft.subtitles} disabled={locked} onChange={(e) => field("subtitles", e.target.checked)} />{t("添加字幕")}</label><p className="mv-hint">{t("配乐、字幕和封面文字由视频模型生成，暂不支持独立后期编辑，请在发布前检查。")}</p></>}
        {step === 7 && <><div className="mv-cover"><AssetPreview file={assets.cover} label={t("视频封面")} /><div><strong>{draft.mainTitle || t("你的故事，即将开场")}</strong><span>{draft.subtitle}</span></div></div>{imageUpload("cover", "选择封面图（选填）")}<p className="mv-hint">{t("此处为封面示意。封面图作为视频首帧，请使用与视频一致的画面比例；实际效果以成片为准。")}</p></>}
        {step === finalStep && <><div className="mv-ready"><span aria-hidden>▷</span><h3>{t("准备好，让故事动起来")}</h3><p>{t("请检查以下设置。确认后将使用账户积分生成视频。")}</p></div><dl className="mv-summary">{[
          ["创作方向", t(draft.direction)], ["画面比例", `${draft.ratio} · ${t(quality.label)} · ${t("{0} 秒", [draft.durationSec])}`],
          ["数字分身", assets.portrait?.name || t("未选择")], ["旁白风格", assets.voice?.name || t(draft.voice)], ["视频背景", [t(draft.background), draft.backgroundDetail, assets.background?.name].filter(Boolean).join(" · ")],
          ["背景音乐", t(draft.bgm)], ["添加字幕", t(draft.subtitles ? "有" : "无")], ["视频封面", assets.cover?.name || t("未选择")],
        ].map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>)}</dl><details className="mv-script-review"><summary>{t("查看文案与标题")}</summary><p>{draft.script}</p><p>{draft.mainTitle} {draft.subtitle}</p><p>{draft.publishTitle} {draft.tags}</p></details><button type="button" className="mv-primary mv-generate" disabled={locked} onClick={() => void submit()}>{t(submitting ? "正在提交…" : "确认设置并生成视频")} ↗</button></>}
        {error && <p className="mv-error" role="alert">{t(error)}</p>}
      </section>
      <footer className="mv-footer"><button type="button" disabled={step === 0 || locked} onClick={() => go(step - 1)}>‹ {t("上一步")}</button><progress max={STEPS.length} value={step + 1} aria-label={t("视频创作步骤")} /><button type="button" className="mv-primary" disabled={step === finalStep || locked} onClick={() => go(step + 1)}>{t(step === finalStep - 1 ? "检查生成设置" : "下一步")} ›</button></footer>
    </>}
    {twinOpen && <DigitalTwinPicker onClose={() => setTwinOpen(false)} onSelect={(file, kind) => selectAsset(file, kind === "voice" ? "voice" : "portrait")} />}
  </div></div>;
}

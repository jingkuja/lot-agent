import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import {
  POSTER_EXPORT_RATIOS, POSTER_FONTS, POSTER_FONT_SCALE, POSTER_LETTER_SPACING, POSTER_LIMITS, POSTER_LINE_SPACING,
  POSTER_NUDGE_LIMIT, POSTER_PARTS, POSTER_STROKES, POSTER_TEMPLATES, parseManualTitleInput, parsePosterStyle,
  posterPartVertical, posterTemplateFor,
  type PosterExportRatio, type PosterFieldName, type PosterFields, type PosterFont, type PosterLayout,
  type PosterPart, type PosterPartStyle, type PosterPreviewScene, type PosterStroke, type PosterStyle, type PosterTemplate,
} from "@lot-agent/core/poster";
import { ApiClientError, type ExportPosterOptions, type PosterPreviewEdit, type PosterPreviewResult } from "../api/client.js";
import type { PosterRedoOverride } from "../lib/image-settings.js";
import { useConfirm } from "../modules/marketing-video/ConfirmDialog.js";
import { useI18n } from "../i18n/index.js";
import { POSTER_PART_LABELS, PosterPreviewCanvas } from "./PosterPreviewCanvas.js";

export const POSTER_TEMPLATE_LABELS: Record<PosterTemplate, string> = {
  bottom_panel: "上图下文", top_panel: "上文下图", side_panel: "左文右图", right_panel: "右文左图", overlay: "文字压图",
};

export const POSTER_FIELD_LABELS: Record<PosterFieldName, string> = {
  title: "标题", subtitle: "副标题", points: "卖点", price: "价格", originalPrice: "原价", discount: "折扣", date: "时间", address: "地址",
};

const NUDGES: { label: string; icon: string; axis: "dx" | "dy"; step: number }[] = [
  { label: "上移", icon: "M12 19V5M5 12l7-7 7 7", axis: "dy", step: -1 },
  { label: "下移", icon: "M12 5v14M5 12l7 7 7-7", axis: "dy", step: 1 },
  { label: "左移", icon: "M19 12H5M12 5l-7 7 7 7", axis: "dx", step: -1 },
  { label: "右移", icon: "M5 12h14M12 5l7 7-7 7", axis: "dx", step: 1 },
];

function partHasText(part: PosterPart, fields: PosterFields, points: string): boolean {
  if (part === "points") return !!points.trim();
  if (part === "price") return !!(fields.price || fields.originalPrice || fields.discount);
  return !!fields[part].trim();
}

const STROKE_LABELS: Record<PosterStroke, string> = { none: "无", thin: "细描边", medium: "中描边" };
const FONT_LABELS: Record<PosterFont, string> = { sans: "黑体", serif: "宋体" };
const EXPORT_RATIO_LABELS: Record<PosterExportRatio, string> = {
  original: "原图比例", "1:1": "1:1 方图", "3:4": "3:4 竖版", "4:3": "4:3 横版", "9:16": "9:16 海报", "16:9": "16:9 横屏",
};

const SHORT_FIELDS: { name: Exclude<PosterFieldName, "title" | "subtitle" | "points">; placeholder: string }[] = [
  { name: "price", placeholder: "如：¥199" },
  { name: "originalPrice", placeholder: "如：¥299" },
  { name: "discount", placeholder: "如：8 折" },
  { name: "date", placeholder: "如：11 月 20 日 – 30 日" },
  { name: "address", placeholder: "如：人民路 88 号" },
];

interface Props {
  imageUrl: string;
  poster: PosterLayout;
  /** Renders the image again with this wording. The dialog closes while the chat card shows progress. */
  onSubmit: (
    fields: PosterFields, template: PosterTemplate, style?: PosterStyle,
    titleOptions?: { titleLines?: string[]; manualTitleLines?: boolean },
  ) => Promise<string | undefined>;
  /** Renders the unsaved edit without storing it. */
  onPreview?: (edit: PosterPreviewEdit, signal: AbortSignal) => Promise<PosterPreviewResult>;
  /** Free instant rollback to a saved snapshot. */
  onRestore?: (versionIndex: number) => Promise<string | undefined>;
  /** Export 1x/2x PNG at the original or target aspect ratio without billing. */
  onExport?: (options: ExportPosterOptions) => Promise<string | undefined>;
  /** Regenerates the background image to match the new template while preserving copy and styles. */
  onRegenerateTemplate?: (override: PosterRedoOverride) => Promise<string | undefined>;
  onClose: () => void;
}

type Preview = { key: string } & ({ scene: PosterPreviewScene; url?: never } | { url: string; scene?: never });

/** Moving a part doesn't change its image, so only layout and styling changes require a new render. */
function previewLayoutKey(
  fields: PosterFields, template: PosterTemplate, style: PosterStyle, titleLines?: string[], manualTitleLines?: boolean,
): string {
  const parts = POSTER_PARTS.flatMap((part) => {
    const own = style.parts?.[part];
    const hasVisual = own?.font || own?.color || own?.vertical !== undefined || own?.fontScale !== undefined
      || own?.letterSpacing !== undefined || own?.lineSpacing !== undefined || own?.stroke || own?.strokeColor;
    return hasVisual
      ? [[part, own.font, own.color, own.vertical, own.fontScale, own.letterSpacing, own.lineSpacing, own.stroke, own.strokeColor]]
      : [];
  });
  return JSON.stringify([fields, template, style.font, style.titleWeight, style.scrim, style.accentColor, parts, titleLines ?? null, !!manualTitleLines]);
}

/** 改字: edit the wording typeset on a 真实字体 image. The server renders it again on the stored picture; no model, no charge. */
export function PosterTextDialog({
  imageUrl, poster, onSubmit, onPreview, onRestore, onExport, onRegenerateTemplate, onClose,
}: Props) {
  const { t } = useI18n();
  const [confirmDialog, confirm] = useConfirm();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [fields, setFields] = useState<PosterFields>(poster.fields);
  const [titleText, setTitleText] = useState(() => (
    poster.manualTitleLines && poster.titleLines?.length ? poster.titleLines.join("\n") : poster.fields.title
  ));
  const [points, setPoints] = useState(poster.fields.points.join("\n"));
  const [template, setTemplate] = useState<PosterTemplate>(poster.template);
  const [style, setStyle] = useState(() => parsePosterStyle(poster.style));
  const [expandedParts, setExpandedParts] = useState<Partial<Record<PosterPart, boolean>>>({});
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  const fit = (value: PosterTemplate) => dimensions ? posterTemplateFor(value, dimensions.width, dimensions.height) : value;
  const effective = fit(template);
  const [busy, setBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [restoringIndex, setRestoringIndex] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportRatio, setExportRatio] = useState<PosterExportRatio>("original");
  const [exportScale, setExportScale] = useState<1 | 2>(1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<Preview>();
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const parsedTitle = parseManualTitleInput(titleText);
  const titleLines = parsedTitle.manualTitleLines ? parsedTitle.titleLines
    : parsedTitle.title === poster.fields.title && !poster.manualTitleLines ? poster.titleLines : undefined;
  const manualTitleLines = parsedTitle.manualTitleLines;
  const draftFields: PosterFields = {
    ...fields,
    title: parsedTitle.title,
    points: points.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, POSTER_LIMITS.points),
  };
  const layoutKey = previewLayoutKey(draftFields, effective, style, titleLines, manualTitleLines);
  const previewUrl = preview?.url;
  const previewCurrent = preview?.key === (preview?.scene ? layoutKey : JSON.stringify([layoutKey, style]));
  const canPreview = !!onPreview;

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const renderPreview = useEffectEvent(async (signal: AbortSignal) => {
    setPreviewError(undefined);
    if (!onPreview || previewCurrent) { setPreviewing(false); return; }
    setPreviewing(true);
    try {
      const result = await onPreview({ fields: draftFields, template: effective, style, titleLines, manualTitleLines }, signal);
      if (signal.aborted) return;
      if (result instanceof Blob) {
        setPreview({ url: URL.createObjectURL(result), key: JSON.stringify([layoutKey, style]) });
      } else {
        setDimensions({ width: result.width, height: result.height });
        setPreview({ scene: result, key: layoutKey });
      }
    } catch (e) {
      if (!signal.aborted) setPreviewError(e instanceof ApiClientError && e.message ? e.message : "预览失败，请稍后重试");
    } finally {
      if (!signal.aborted) setPreviewing(false);
    }
  });
  useEffect(() => {
    if (!canPreview) return;
    const request = new AbortController();
    const timer = window.setTimeout(() => void renderPreview(request.signal), 350);
    return () => { window.clearTimeout(timer); request.abort(); };
  }, [canPreview, layoutKey, refresh]);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const set = (name: Exclude<PosterFieldName, "points">, value: string) => {
    setFields((current) => ({ ...current, [name]: value }));
    setError(undefined);
  };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    let failure: string | undefined;
    try {
      // Return to the chat immediately. The generation card keeps the old
      // image under a progress mask until the newly rendered image arrives.
      const request = onSubmit(draftFields, effective, style, { titleLines, manualTitleLines });
      onClose();
      failure = await request;
    } catch {
      failure = "改字失败，请稍后重试";
    }
    if (!dialog.current?.isConnected) return;
    setBusy(false);
    if (failure) setError(failure);
  };
  const restoreVersion = async (versionIndex: number) => {
    const snap = poster.history?.[versionIndex];
    if (!onRestore || !snap || restoringIndex !== null || busy) return;
    setRestoringIndex(versionIndex);
    setError(undefined);
    try {
      const failure = await onRestore(versionIndex);
      if (failure) { setError(failure); return; }
      setFields(snap.fields);
      setTitleText(snap.manualTitleLines && snap.titleLines?.length ? snap.titleLines.join("\n") : snap.fields.title);
      setPoints(snap.fields.points.join("\n"));
      setTemplate(snap.template);
      setStyle(parsePosterStyle(snap.style));
      setRefresh((cur) => cur + 1);
    } finally {
      if (dialog.current?.isConnected) setRestoringIndex(null);
    }
  };
  const triggerExport = async () => {
    if (!onExport || exporting || busy) return;
    setExporting(true);
    setError(undefined);
    try {
      const failure = await onExport({
        fields: draftFields, template: effective, style, titleLines, manualTitleLines, scale: exportScale, ratio: exportRatio,
      });
      if (failure) setError(failure);
    } finally {
      if (dialog.current?.isConnected) setExporting(false);
    }
  };
  const regenerateTemplate = async () => {
    if (!onRegenerateTemplate || regenerating || busy) return;
    const ok = await confirm({
      title: "按新模板重出底图",
      message: "按新选择的「{0}」版式重新生成无字底图并自动排字，保留当前文案与样式，按 1 张图片计费。",
      values: [t(POSTER_TEMPLATE_LABELS[effective])],
      confirm: "重新出图",
    });
    if (!ok) return;
    setRegenerating(true);
    setError(undefined);
    try {
      const failure = await onRegenerateTemplate({
        fields: draftFields, template: effective, style, titleLines, manualTitleLines,
      });
      if (failure) { setError(failure); return; }
      onClose();
    } finally {
      if (dialog.current?.isConnected) setRegenerating(false);
    }
  };
  const cleared = (poster.cleared ?? []).map((name) => t(POSTER_FIELD_LABELS[name]));
  const setPart = (part: PosterPart, change: (current: PosterPartStyle) => PosterPartStyle) => {
    setStyle((current) => parsePosterStyle({ ...current, parts: { ...current.parts, [part]: change(current.parts?.[part] ?? {}) } }));
  };
  const nudge = (part: PosterPart, axis: "dx" | "dy", step: number) => setPart(part, (current) => ({
    ...current, [axis]: Math.max(-POSTER_NUDGE_LIMIT, Math.min(POSTER_NUDGE_LIMIT, (current[axis] ?? 0) + step)),
  }));
  const resizePart = (part: PosterPart, step: number) => setPart(part, (current) => ({
    ...current, fontScale: (current.fontScale ?? POSTER_FONT_SCALE.default) + step,
  }));
  const stepPartMetric = (part: PosterPart, key: "letterSpacing" | "lineSpacing", step: number, fallback: number) => (
    setPart(part, (current) => ({ ...current, [key]: (current[key] ?? fallback) + step }))
  );
  const parts = POSTER_PARTS.filter((part) => partHasText(part, draftFields, points));
  const hint = preview?.scene && !previewError ? "拖动文字移动位置，拖边角可缩放字号，方向键可微调"
    : canPreview && !preview && !previewError ? "正在加载可拖动预览…" : "每次移动画布的 1%，保存后生效";
  const dialogBusy = busy || regenerating || exporting || restoringIndex !== null;

  return (
    <dialog ref={dialog} className="image-edit-dialog poster-text-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!dialogBusy) onClose(); }}>
      <header className="image-edit-head">
        <h2 id={titleId}>{t("改字")}</h2>
        <button type="button" className="image-edit-close" onClick={onClose} disabled={dialogBusy} aria-label={t("关闭")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <form className="poster-text-body" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="image-edit-preview poster-text-preview">
          {preview?.scene ? <PosterPreviewCanvas scene={preview.scene} style={style} interactive={!dialogBusy && previewCurrent}
            onMove={(part, offset) => setPart(part, (current) => ({ ...current, ...offset }))}
            onResize={(part, fontScale) => setPart(part, (current) => ({ ...current, fontScale }))} />
            : <img className="poster-preview-flat" src={previewUrl ?? imageUrl} draggable={false}
              alt={t(preview ? "预览效果" : "当前生成图")} onLoad={({ currentTarget }) => {
                setDimensions({ width: currentTarget.naturalWidth, height: currentTarget.naturalHeight });
              }} />}
          {preview && !previewCurrent && <span className="poster-text-preview-badge" role="status">
            {t(preview.scene && !previewError ? "预览更新中…" : "已有新改动，点预览更新")}
          </span>}
        </div>
        <div className="poster-text-fields">
          {cleared.length > 0 && (
            <p className="poster-text-notice" role="status">{t("这些内容没在你的描述里找到，已留空，可以在这里填写：{0}", [cleared.join(t("、"))])}</p>
          )}
          {poster.backgroundSuspect && (
            <p className="poster-text-notice" role="status">{t("文字区域底图纹理较复杂，可开启轻柔/加强遮罩提升清晰度。")}</p>
          )}
          <div className="gen-compose-layouts" role="radiogroup" aria-label={t("文字位置")}>
            {POSTER_TEMPLATES.filter((item) => fit(item) === item).map((item) => (
              <button key={item} type="button" role="radio" aria-checked={item === effective}
                className={`gen-compose-layout${item === effective ? " active" : ""}`} onClick={() => setTemplate(item)}>
                {t(POSTER_TEMPLATE_LABELS[item])}
              </button>
            ))}
          </div>
          {effective !== fit(poster.template) && (
            <div className="poster-template-warn">
              <p className="poster-text-notice" role="status">{t("改变文字位置后，文字可能遮挡图片主体。")}</p>
              {onRegenerateTemplate && (
                <button type="button" className="poster-regen-btn" disabled={dialogBusy} onClick={() => void regenerateTemplate()}>
                  {t(regenerating ? "正在重出底图…" : "按新模板重出底图")}
                </button>
              )}
            </div>
          )}
          <div className="poster-text-grid">
            {([
              ["font", "字体", [["sans", "黑体"], ["serif", "宋体"]]],
              ["titleWeight", "标题字重", [["regular", "常规"], ["bold", "粗体"]]],
              ["scrim", "文字底色", [["auto", "自动"], ["transparent", "纯透明"], ["soft", "轻柔遮罩"], ["strong", "加强遮罩"]]],
            ] as const).map(([name, label, options]) => <label className="poster-text-field" key={name}>
              <span>{t(label)}</span>
              <select value={style[name]} disabled={busy} onChange={event => setStyle(current => parsePosterStyle({
                ...current, [name]: event.target.value,
              }))}>
                {options.map(([value, text]) => <option value={value} key={value}>{t(text)}</option>)}
              </select>
            </label>)}
            <div className="poster-text-field">
              <span>{t("强调色")}</span>
              <div className="poster-accent-row">
                <label className={`poster-part-color${style.accentColor ? "" : " auto"}`}>
                  <input type="color" value={style.accentColor ?? "#ff5a36"} aria-label={t("强调色")} disabled={busy}
                    onChange={(event) => setStyle((current) => parsePosterStyle({ ...current, accentColor: event.target.value }))} />
                  <span>{style.accentColor ? style.accentColor.toUpperCase() : t("自动")}</span>
                </label>
                {style.accentColor && (
                  <button type="button" className="poster-part-reset" disabled={busy}
                    onClick={() => setStyle((current) => parsePosterStyle({ ...current, accentColor: undefined }))}>
                    {t("还原")}
                  </button>
                )}
              </div>
            </div>
          </div>
          {parts.length > 0 && <fieldset className="poster-part-list" disabled={busy}>
            <legend>{t("逐段调整")}</legend>
            <div className="poster-part-head">
              <p className="poster-part-hint">{t(hint)}</p>
              {canPreview && <button type="button" className="poster-part-preview" onClick={() => setRefresh((current) => current + 1)}
                disabled={previewing || previewCurrent}>
                {previewing ? t("预览中…") : t("预览")}
              </button>}
            </div>
            {previewError && <p className="poster-part-error" role="alert">{t(previewError)}</p>}
            {parts.map((part) => {
              const own = style.parts?.[part];
              const label = t(POSTER_PART_LABELS[part]);
              const vertical = posterPartVertical(style, part, effective);
              const fontScale = own?.fontScale ?? POSTER_FONT_SCALE.default;
              const letterSpacing = own?.letterSpacing ?? POSTER_LETTER_SPACING.default;
              const lineSpacing = own?.lineSpacing ?? POSTER_LINE_SPACING.default;
              const stroke = own?.stroke ?? "none";
              const expanded = !!expandedParts[part];
              const hasExtraStyle = !!own?.font || letterSpacing !== POSTER_LETTER_SPACING.default
                || lineSpacing !== POSTER_LINE_SPACING.default || stroke !== "none";
              return <div className="poster-part-item" key={part}>
                <div className="poster-part-row">
                  <span className="poster-part-name" title={label}>{label}</span>
                  <label className={`poster-part-color${own?.color ? "" : " auto"}`} title={t("文字颜色")}>
                    <input type="color" value={own?.color ?? "#ffffff"} aria-label={t("{0}文字颜色", [label])}
                      onChange={(event) => setPart(part, (current) => ({ ...current, color: event.target.value }))} />
                    <span>{own?.color ? own.color.toUpperCase() : t("自动")}</span>
                  </label>
                  <div className="poster-part-position">
                    <div className="poster-part-nudges" role="group" aria-label={t("{0}位置", [label])}>
                      {NUDGES.map(({ label: name, icon, axis, step }) => (
                        <button key={name} type="button" className="poster-part-nudge" aria-label={t(name)} title={t(name)}
                          disabled={Math.abs((own?.[axis] ?? 0) + step) > POSTER_NUDGE_LIMIT} onClick={() => nudge(part, axis, step)}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d={icon} />
                          </svg>
                        </button>
                      ))}
                    </div>
                    <span className="poster-part-offset" aria-live="polite">
                      {own?.dx || own?.dy ? `${own.dx ?? 0}, ${own.dy ?? 0}` : ""}
                    </span>
                  </div>
                  <div className="poster-part-actions">
                    <div className="poster-part-size" role="group" aria-label={t("{0}字号", [label])}>
                      <button type="button" className="poster-part-nudge" disabled={fontScale <= POSTER_FONT_SCALE.min}
                        aria-label={t("缩小{0}字号", [label])} title={t("缩小{0}字号", [label])}
                        onClick={() => resizePart(part, -POSTER_FONT_SCALE.step)}>−</button>
                      <span className="poster-part-size-value" aria-live="polite">{fontScale}%</span>
                      <button type="button" className="poster-part-nudge" disabled={fontScale >= POSTER_FONT_SCALE.max}
                        aria-label={t("放大{0}字号", [label])} title={t("放大{0}字号", [label])}
                        onClick={() => resizePart(part, POSTER_FONT_SCALE.step)}>+</button>
                    </div>
                    <button type="button" className="poster-part-nudge poster-part-turn" aria-pressed={vertical}
                      aria-label={t("{0}反转", [label])} title={t(vertical ? "反转：改为横排" : "反转：改为竖排")}
                      onClick={() => setPart(part, (current) => ({ ...current, vertical: !vertical }))}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5" />
                      </svg>
                    </button>
                    <button type="button" className={`poster-part-reset poster-part-style-toggle${hasExtraStyle ? " active" : ""}`}
                      aria-expanded={expanded} onClick={() => setExpandedParts((cur) => ({ ...cur, [part]: !cur[part] }))}>
                      {t("样式")}
                    </button>
                    <button type="button" className="poster-part-reset" disabled={!own} onClick={() => setPart(part, () => ({}))}>
                      {t("还原")}
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div className="poster-part-extra">
                    <label className="poster-part-metric poster-part-stroke-field">
                      <span>{t("字体")}</span>
                      <select value={own?.font ?? ""} aria-label={t("{0}字体", [label])} onChange={(event) => {
                        const value = event.target.value as PosterFont | "";
                        setPart(part, (current) => ({ ...current, font: value || undefined }));
                      }}>
                        <option value="">{t("跟随全局")}</option>
                        {POSTER_FONTS.map((item) => <option key={item} value={item}>{t(FONT_LABELS[item])}</option>)}
                      </select>
                    </label>
                    <div className="poster-part-metric">
                      <span>{t("字间距")}</span>
                      <div className="poster-part-size" role="group" aria-label={t("字间距")}>
                        <button type="button" className="poster-part-nudge" disabled={letterSpacing <= POSTER_LETTER_SPACING.min}
                          aria-label={t("减小{0}字间距", [label])}
                          onClick={() => stepPartMetric(part, "letterSpacing", -POSTER_LETTER_SPACING.step, POSTER_LETTER_SPACING.default)}>−</button>
                        <span className="poster-part-size-value">{letterSpacing}%</span>
                        <button type="button" className="poster-part-nudge" disabled={letterSpacing >= POSTER_LETTER_SPACING.max}
                          aria-label={t("增大{0}字间距", [label])}
                          onClick={() => stepPartMetric(part, "letterSpacing", POSTER_LETTER_SPACING.step, POSTER_LETTER_SPACING.default)}>+</button>
                      </div>
                    </div>
                    <div className="poster-part-metric">
                      <span>{t("行距")}</span>
                      <div className="poster-part-size" role="group" aria-label={t("行距")}>
                        <button type="button" className="poster-part-nudge" disabled={lineSpacing <= POSTER_LINE_SPACING.min}
                          aria-label={t("减小{0}行距", [label])}
                          onClick={() => stepPartMetric(part, "lineSpacing", -POSTER_LINE_SPACING.step, POSTER_LINE_SPACING.default)}>−</button>
                        <span className="poster-part-size-value">{lineSpacing}%</span>
                        <button type="button" className="poster-part-nudge" disabled={lineSpacing >= POSTER_LINE_SPACING.max}
                          aria-label={t("增大{0}行距", [label])}
                          onClick={() => stepPartMetric(part, "lineSpacing", POSTER_LINE_SPACING.step, POSTER_LINE_SPACING.default)}>+</button>
                      </div>
                    </div>
                    <label className="poster-part-metric poster-part-stroke-field">
                      <span>{t("描边")}</span>
                      <select value={stroke} aria-label={t("{0}描边", [label])} onChange={(event) => {
                        const value = event.target.value as PosterStroke;
                        setPart(part, (current) => ({ ...current, stroke: value }));
                      }}>
                        {POSTER_STROKES.map((item) => <option key={item} value={item}>{t(STROKE_LABELS[item])}</option>)}
                      </select>
                    </label>
                    {stroke !== "none" && (
                      <label className={`poster-part-color${own?.strokeColor ? "" : " auto"}`} title={t("描边颜色")}>
                        <input type="color" value={own?.strokeColor ?? "#181818"} aria-label={t("描边颜色")}
                          onChange={(event) => setPart(part, (current) => ({ ...current, strokeColor: event.target.value }))} />
                        <span>{own?.strokeColor ? own.strokeColor.toUpperCase() : t("自动")}</span>
                      </label>
                    )}
                  </div>
                )}
              </div>;
            })}
          </fieldset>}
          <label className="poster-text-field">
            <span className="poster-field-label">
              <span>{t("标题")}</span>
              <span className="poster-field-hint">{t("换行或 | 手动断行，【词】高亮")}</span>
            </span>
            <textarea rows={2} value={titleText} maxLength={POSTER_LIMITS.title + 20}
              onChange={(event) => { setTitleText(event.target.value); setError(undefined); }} />
          </label>
          <label className="poster-text-field">
            <span>{t("副标题")}</span>
            <input value={fields.subtitle} maxLength={POSTER_LIMITS.subtitle} onChange={(event) => set("subtitle", event.target.value)} />
          </label>
          <label className="poster-text-field">
            <span>{t("卖点")}</span>
            <textarea rows={3} value={points} placeholder={t("每行一条，最多 4 条")}
              onChange={(event) => { setPoints(event.target.value); setError(undefined); }} />
          </label>
          <div className="poster-text-grid">
            {SHORT_FIELDS.map(({ name, placeholder }) => (
              <label key={name} className={`poster-text-field${name === "address" ? " poster-text-field--wide" : ""}`}>
                <span>{t(POSTER_FIELD_LABELS[name])}</span>
                <input value={fields[name]} maxLength={POSTER_LIMITS[name]} placeholder={t(placeholder)}
                  onChange={(event) => set(name, event.target.value)} />
              </label>
            ))}
          </div>
          <div className="gen-compose-actions">
            <button type="submit" className="gen-compose-submit" disabled={dialogBusy}>{busy ? t("排版中…") : t("保存并重新排版")}</button>
            <span className="gen-compose-free">{t("改字不扣积分，画面不变")}</span>
          </div>
          {onExport && (
            <div className="poster-export-bar">
              <span className="poster-export-label">{t("高清导出")}</span>
              <select value={exportRatio} aria-label={t("导出比例")} disabled={dialogBusy}
                onChange={(event) => setExportRatio(event.target.value as PosterExportRatio)}>
                {POSTER_EXPORT_RATIOS.map((item) => <option key={item} value={item}>{t(EXPORT_RATIO_LABELS[item])}</option>)}
              </select>
              <div className="poster-part-size" role="group" aria-label={t("导出分辨率")}>
                {([1, 2] as const).map((s) => (
                  <button key={s} type="button" className={`poster-part-reset${exportScale === s ? " active" : ""}`}
                    disabled={dialogBusy} onClick={() => setExportScale(s)}>
                    {s === 2 ? t("2x 高清") : t("1x 原尺")}
                  </button>
                ))}
              </div>
              <button type="button" className="poster-part-preview" disabled={dialogBusy} onClick={() => void triggerExport()}>
                {exporting ? t("导出中…") : t("导出 PNG")}
              </button>
            </div>
          )}
          {poster.history && poster.history.length > 0 && onRestore && (
            <div className="poster-history">
              <button type="button" className="poster-history-toggle" aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((cur) => !cur)}>
                <span>{t("历史版本（{0}）", [poster.history.length])}</span>
                <span>{t(historyOpen ? "收起" : "展开")}</span>
              </button>
              {historyOpen && (
                <ul className="poster-history-list">
                  {poster.history.map((snap, idx) => (
                    <li key={`${snap.asset.url}-${idx}`} className="poster-history-item">
                      <span className="poster-history-meta">
                        <strong>{t(POSTER_TEMPLATE_LABELS[snap.template])}</strong>
                        <span className="poster-history-title">{snap.fields.title || t("无标题")}</span>
                      </span>
                      <button type="button" className="poster-part-reset" disabled={dialogBusy}
                        onClick={() => void restoreVersion(idx)}>
                        {restoringIndex === idx ? t("恢复中…") : t("恢复此版")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {error && <p className="image-edit-error" role="alert">{t(error)}</p>}
        </div>
      </form>
      {confirmDialog}
    </dialog>
  );
}

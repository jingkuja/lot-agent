import { useEffect, useId, useRef, useState } from "react";
import { POSTER_LIMITS, POSTER_NUDGE_LIMIT, POSTER_TEMPLATES, parsePosterStyle, posterPartVertical, posterTemplateFor, type PosterFieldName,
  type PosterFields,
  type PosterLayout, type PosterPart, type PosterPartStyle, type PosterStyle, type PosterTemplate } from "@lot-agent/core/poster";
import { ApiClientError } from "../api/client.js";
import { useI18n } from "../i18n/index.js";

export const POSTER_TEMPLATE_LABELS: Record<PosterTemplate, string> = {
  bottom_panel: "上图下文", top_panel: "上文下图", side_panel: "左文右图", right_panel: "右文左图", overlay: "文字压图",
};

export const POSTER_FIELD_LABELS: Record<PosterFieldName, string> = {
  title: "标题", subtitle: "副标题", points: "卖点", price: "价格", originalPrice: "原价", discount: "折扣", date: "时间", address: "地址",
};

const PART_LABELS: Record<PosterPart, string> = {
  title: "标题", subtitle: "副标题", points: "卖点", price: "价格", footer: "时间地址",
};

const NUDGES: { label: string; icon: string; axis: "dx" | "dy"; step: number }[] = [
  { label: "上移", icon: "M12 19V5M5 12l7-7 7 7", axis: "dy", step: -1 },
  { label: "下移", icon: "M12 5v14M5 12l7 7 7-7", axis: "dy", step: 1 },
  { label: "左移", icon: "M19 12H5M12 5l-7 7 7 7", axis: "dx", step: -1 },
  { label: "右移", icon: "M5 12h14M12 5l7 7-7 7", axis: "dx", step: 1 },
];

function partHasText(part: PosterPart, fields: PosterFields, points: string): boolean {
  if (part === "points") return !!points.trim();
  if (part === "price") return !!(fields.price || fields.originalPrice);
  if (part === "footer") return !!(fields.date || fields.address);
  return !!fields[part].trim();
}

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
  onSubmit: (fields: PosterFields, template: PosterTemplate, style?: PosterStyle) => Promise<string | undefined>;
  /** Renders the unsaved edit without storing it. Undefined hides 预览. */
  onPreview?: (fields: PosterFields, template: PosterTemplate, style?: PosterStyle) => Promise<Blob>;
  onClose: () => void;
}

/** 改字: edit the wording typeset on a 真实字体 image. The server renders it again on the stored picture; no model, no charge. */
export function PosterTextDialog({ imageUrl, poster, onSubmit, onPreview, onClose }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [fields, setFields] = useState<PosterFields>(poster.fields);
  const [points, setPoints] = useState(poster.fields.points.join("\n"));
  const [template, setTemplate] = useState<PosterTemplate>(poster.template);
  const [style, setStyle] = useState(() => parsePosterStyle(poster.style));
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  const fit = (value: PosterTemplate) => dimensions ? posterTemplateFor(value, dimensions.width, dimensions.height) : value;
  const effective = fit(template);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<{ url: string; edit: string }>();
  const [previewing, setPreviewing] = useState(false);
  const previewRequest = useRef(0);
  const lines = () => points.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, POSTER_LIMITS.points);
  const edit = JSON.stringify([fields, lines(), effective, style]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => () => { previewRequest.current += 1; }, []);

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
      const request = onSubmit({ ...fields, points: lines() }, effective, style);
      onClose();
      failure = await request;
    } catch {
      failure = "改字失败，请稍后重试";
    }
    if (!dialog.current?.isConnected) return;
    setBusy(false);
    if (failure) setError(failure);
  };
  const showPreview = async () => {
    if (!onPreview || previewing) return;
    const request = ++previewRequest.current;
    setPreviewing(true);
    setError(undefined);
    try {
      const blob = await onPreview({ ...fields, points: lines() }, effective, style);
      if (request === previewRequest.current) setPreview({ url: URL.createObjectURL(blob), edit });
    } catch (e) {
      if (request === previewRequest.current) setError(e instanceof ApiClientError && e.message ? e.message : "预览失败，请稍后重试");
    } finally {
      if (request === previewRequest.current) setPreviewing(false);
    }
  };
  const cleared = (poster.cleared ?? []).map((name) => t(POSTER_FIELD_LABELS[name]));
  const setPart = (part: PosterPart, change: (current: PosterPartStyle) => PosterPartStyle) => {
    setStyle((current) => parsePosterStyle({ ...current, parts: { ...current.parts, [part]: change(current.parts?.[part] ?? {}) } }));
  };
  const nudge = (part: PosterPart, axis: "dx" | "dy", step: number) => setPart(part, (current) => ({
    ...current, [axis]: Math.max(-POSTER_NUDGE_LIMIT, Math.min(POSTER_NUDGE_LIMIT, (current[axis] ?? 0) + step)),
  }));
  const parts = (Object.keys(PART_LABELS) as PosterPart[]).filter((part) => partHasText(part, fields, points));

  return (
    <dialog ref={dialog} className="image-edit-dialog poster-text-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <header className="image-edit-head">
        <h2 id={titleId}>{t("改字")}</h2>
        <button type="button" className="image-edit-close" onClick={onClose} disabled={busy} aria-label={t("关闭")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <form className="poster-text-body" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="image-edit-preview poster-text-preview">
          <img src={preview?.url ?? imageUrl} alt={t(preview ? "预览效果" : "当前生成图")} onLoad={({ currentTarget }) => {
            setDimensions({ width: currentTarget.naturalWidth, height: currentTarget.naturalHeight });
          }} />
          {preview && <span className={`poster-text-preview-badge${preview.edit === edit ? "" : " stale"}`} role="status">
            {t(preview.edit === edit ? "预览效果，保存后生效" : "已有新改动，点预览更新")}
          </span>}
        </div>
        <div className="poster-text-fields">
          {cleared.length > 0 && (
            <p className="poster-text-notice" role="status">{t("这些内容没在你的描述里找到，已留空，可以在这里填写：{0}", [cleared.join(t("、"))])}</p>
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
            <p className="poster-text-notice" role="status">{t("改变文字位置后，文字可能遮挡图片主体。")}</p>
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
          </div>
          {parts.length > 0 && <fieldset className="poster-part-list" disabled={busy}>
            <legend>{t("逐段调整")}</legend>
            <div className="poster-part-head">
              <p className="poster-part-hint">{t("每次移动画布的 1%，保存后生效")}</p>
              {onPreview && <button type="button" className="poster-part-preview" onClick={() => void showPreview()}
                disabled={previewing || preview?.edit === edit}>
                {previewing ? t("预览中…") : t("预览")}
              </button>}
            </div>
            {parts.map((part) => {
              const own = style.parts?.[part];
              const label = t(PART_LABELS[part]);
              const vertical = posterPartVertical(style, part, effective);
              return <div className="poster-part-row" key={part}>
                <span className="poster-part-name">{label}</span>
                <label className={`poster-part-color${own?.color ? "" : " auto"}`} title={t("文字颜色")}>
                  <input type="color" value={own?.color ?? "#ffffff"} aria-label={t("{0}文字颜色", [label])}
                    onChange={(event) => setPart(part, (current) => ({ ...current, color: event.target.value }))} />
                  <span>{own?.color ? own.color.toUpperCase() : t("自动")}</span>
                </label>
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
                <button type="button" className="poster-part-nudge poster-part-turn" aria-pressed={vertical}
                  aria-label={t("{0}反转", [label])} title={t(vertical ? "反转：改为横排" : "反转：改为竖排")}
                  onClick={() => setPart(part, (current) => ({ ...current, vertical: !vertical }))}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5" />
                  </svg>
                </button>
                <button type="button" className="poster-part-reset" disabled={!own} onClick={() => setPart(part, () => ({}))}>
                  {t("还原")}
                </button>
              </div>;
            })}
          </fieldset>}
          <label className="poster-text-field">
            <span>{t("标题")}</span>
            <input autoFocus value={fields.title} maxLength={POSTER_LIMITS.title} onChange={(event) => set("title", event.target.value)} />
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
            <button type="submit" className="gen-compose-submit" disabled={busy}>{busy ? t("排版中…") : t("保存并重新排版")}</button>
            <span className="gen-compose-free">{t("改字不扣积分，画面不变")}</span>
          </div>
          {error && <p className="image-edit-error" role="alert">{t(error)}</p>}
        </div>
      </form>
    </dialog>
  );
}

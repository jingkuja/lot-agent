import { useEffect, useId, useRef, useState } from "react";
import { POSTER_LIMITS, POSTER_TEMPLATES, posterTemplateFor, type PosterFieldName, type PosterFields, type PosterLayout, type PosterTemplate } from "@lot-agent/core/poster";
import { useI18n } from "../i18n/index.js";

export const POSTER_TEMPLATE_LABELS: Record<PosterTemplate, string> = {
  bottom_panel: "上图下文", top_panel: "上文下图", side_panel: "左文右图", overlay: "文字压图",
};

export const POSTER_FIELD_LABELS: Record<PosterFieldName, string> = {
  title: "标题", subtitle: "副标题", points: "卖点", price: "价格", originalPrice: "原价", discount: "折扣", date: "时间", address: "地址",
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
  /** Renders the image again with this wording. Resolves to an error to keep the dialog open, or nothing once saved. */
  onSubmit: (fields: PosterFields, template: PosterTemplate) => Promise<string | undefined>;
  onClose: () => void;
}

/** 改字: edit the wording typeset on a 真实字体 image. The server renders it again on the stored picture; no model, no charge. */
export function PosterTextDialog({ imageUrl, poster, onSubmit, onClose }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [fields, setFields] = useState<PosterFields>(poster.fields);
  const [points, setPoints] = useState(poster.fields.points.join("\n"));
  const [template, setTemplate] = useState<PosterTemplate>(poster.template);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  const fit = (value: PosterTemplate) => dimensions ? posterTemplateFor(value, dimensions.width, dimensions.height) : value;
  const effective = fit(template);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

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
    const lines = points.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, POSTER_LIMITS.points);
    let failure: string | undefined;
    try {
      failure = await onSubmit({ ...fields, points: lines }, effective);
    } catch {
      failure = "改字失败，请稍后重试";
    }
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };
  const cleared = (poster.cleared ?? []).map((name) => t(POSTER_FIELD_LABELS[name]));

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
          <img src={imageUrl} alt={t("当前生成图")} onLoad={({ currentTarget }) => {
            setDimensions({ width: currentTarget.naturalWidth, height: currentTarget.naturalHeight });
          }} />
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

import { useState, type FormEvent } from "react";
import { useI18n } from "../../../i18n/index.js";
import type { MarketingBrandAssets, MarketingVisualAsset } from "../types.js";
import { MAX_STORE_PHOTOS, splitBusinessImages } from "./business-images.js";
import { lines, splitLines, TextRows } from "./form-fields.js";
import { ImagePicker, ImageTile, keepDrop, useImageUpload } from "./ImageUpload.js";

export interface BusinessProfileInput {
  businessName: string;
  businessIntro: string;
  visualAssets: MarketingVisualAsset[];
  tone: string[];
  standardCallsToAction: string[];
}

interface Props {
  brand: MarketingBrandAssets | null;
  onClose: () => void;
  onSave: (input: BusinessProfileInput) => Promise<void>;
}

export function BusinessProfileEditor({ brand, onClose, onSave }: Props) {
  const { t } = useI18n();
  const initial = splitBusinessImages(brand?.visualAssets);
  const [name, setName] = useState(brand?.businessName ?? "");
  const [intro, setIntro] = useState(brand?.businessIntro ?? "");
  const [logo, setLogo] = useState(initial.logo);
  const [photos, setPhotos] = useState(initial.photos);
  const [others, setOthers] = useState(initial.others);
  const [tone, setTone] = useState(lines(brand?.tone));
  const [ctas, setCtas] = useState(lines(brand?.standardCallsToAction));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasWritingNotes = Boolean(brand?.tone.length || brand?.standardCallsToAction.length);

  const { uploading, upload } = useImageUpload(setError);

  const addLogo = async (files: File[]) => {
    setError(null);
    const [uploaded] = await upload(files.slice(0, 1));
    if (uploaded) setLogo({ ...uploaded, type: "logo" });
  };

  const addPhotos = async (files: File[]) => {
    setError(null);
    const room = MAX_STORE_PHOTOS - photos.length - uploading;
    if (files.length > room) setError(t("最多放 {0} 张图片", [MAX_STORE_PHOTOS]));
    const uploaded = await upload(files.slice(0, Math.max(room, 0)));
    setPhotos((current) => [...current, ...uploaded.map((item) => ({ ...item, type: "store" }))]);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({
        businessName: name.trim(),
        businessIntro: intro.trim(),
        visualAssets: [...(logo ? [logo] : []), ...photos, ...others],
        tone: splitLines(tone),
        standardCallsToAction: splitLines(ctas),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return <div className="de-modal-backdrop" onMouseDown={onClose} onDragOver={keepDrop} onDrop={keepDrop}>
    <section className="de-modal marketing-editor-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
      <div className="de-modal-head">
        <div><h2>{t("公司 / 店铺资料")}</h2><p>{t("写文案、做海报、跟进客户时都会用到。")}</p></div>
        <button className="de-icon-button" aria-label={t("关闭")} onClick={onClose}>×</button>
      </div>
      <form className="de-form" onSubmit={(event) => void submit(event)}>
        <div className="de-form-grid">
          <label className="marketing-form-wide">
            <span>{t("公司或店铺名称")}</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={200} />
          </label>
          <label className="marketing-form-wide">
            <span>{t("基础介绍")}</span>
            <textarea
              value={intro} onChange={(event) => setIntro(event.target.value)} rows={5} maxLength={4000}
              placeholder={t("做什么的、开在哪、营业时间、联系电话，想到什么写什么")}
            />
          </label>
          <div className="marketing-form-wide marketing-image-field">
            <span>{t("Logo 图片")}</span>
            <div className="marketing-image-row">
              {logo
                ? <ImageTile url={logo.url} label={t("Logo 图片")} logo onRemove={() => setLogo(null)} />
                : <ImagePicker label={t("上传 Logo")} disabled={uploading > 0} onFiles={(files) => void addLogo(files)} />}
            </div>
          </div>
          <div className="marketing-form-wide marketing-image-field">
            <span>{t("公司 / 店面图片")} <small>{t("门头、店内、办公环境都可以")}</small></span>
            <div className="marketing-image-row">
              {photos.map((photo) => (
                <ImageTile
                  key={photo.url} url={photo.url} label={photo.name}
                  onRemove={() => setPhotos((current) => current.filter((item) => item !== photo))}
                />
              ))}
              {photos.length < MAX_STORE_PHOTOS && (
                <ImagePicker label={t("上传图片")} multiple disabled={uploading > 0} onFiles={(files) => void addPhotos(files)} />
              )}
            </div>
          </div>
          {others.length > 0 && (
            <div className="marketing-form-wide marketing-image-field">
              <span>{t("其他素材")}</span>
              <ul className="marketing-other-assets">
                {others.map((asset) => (
                  <li key={asset.url}>
                    <a href={asset.url} target="_blank" rel="noreferrer">{asset.name}</a>
                    <button
                      type="button" aria-label={t("移除 {0}", [asset.name])}
                      onClick={() => setOthers((current) => current.filter((item) => item !== asset))}
                    >×</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <details className="marketing-form-wide marketing-writing-notes" open={hasWritingNotes}>
            <summary>{t("文案要求（选填）")}</summary>
            <div>
              <TextRows label="说话风格" hint="每行一条，如：亲切实在" value={tone} onChange={setTone} />
              <TextRows label="常用的行动引导" hint="每行一条，如：到店领取试吃" value={ctas} onChange={setCtas} />
            </div>
          </details>
        </div>
        {error && <p className="de-form-error">{t(error)}</p>}
        <footer className="de-modal-actions">
          <button type="button" className="de-secondary-button" onClick={onClose}>{t("取消")}</button>
          <button className="de-primary-button" disabled={saving || uploading > 0}>
            {saving ? t("保存中…") : uploading > 0 ? t("上传中…") : t("保存")}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}

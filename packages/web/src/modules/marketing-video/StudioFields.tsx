import { marketingAssetIds, type MarketingDraft } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { imageCount, isImageSlot, materialFor, type Material, type MaterialSlot } from "./materials.js";

/** The open draft and whether it can be edited. A submitted (frozen) draft keeps only
 * its publication title and tags editable. */
export interface DraftForm {
  draft: MarketingDraft;
  busy: boolean;
  frozen: boolean;
  ready: boolean;
  field<K extends keyof MarketingDraft>(name: K, value: MarketingDraft[K]): void;
}

export function Choices({ form, label, values, value, onChoose }: {
  form: DraftForm; label: string; values: { value: string; label: string }[]; value: string; onChoose(value: string): void;
}) {
  const { t } = useI18n();
  return <div className="mv-choices" role="group" aria-label={t(label)}>
    {values.map(item => <button key={item.value} type="button" disabled={form.busy || form.frozen || !form.ready} className={value === item.value ? "selected" : ""}
      aria-pressed={value === item.value} onClick={() => onChoose(item.value)}>{t(item.label)}</button>)}
  </div>;
}

type TextName = "topic" | "reference" | "script" | "background" | "continuity" | "publishTitle" | "tags";

export function DraftText({ form, name, label, max, rows = 2 }: { form: DraftForm; name: TextName; label: string; max: number; rows?: number }) {
  const { t } = useI18n();
  const locked = form.frozen && name !== "publishTitle" && name !== "tags";
  return <label className="mv-field"><span>{t(label)}</span>
    <textarea value={form.draft[name]} rows={rows} maxLength={max} disabled={form.busy || !form.ready || locked} onChange={e => form.field(name, e.target.value)} />
  </label>;
}

/** Upload button and previews of one material slot. */
export interface MaterialHandlers {
  materials: Record<string, Material>;
  onFiles(slot: MaterialSlot, files: File[]): void;
  onRemove(slot: MaterialSlot, id: string): void;
  /** Re-authorize a preview whose temporary link expired. */
  onRefresh(id: string): void;
}

export function MaterialField({ form, slot, label, accept, handlers }: { form: DraftForm; slot: MaterialSlot; label: string; accept: string; handlers: MaterialHandlers }) {
  const { t } = useI18n();
  const { draft, busy, frozen, ready } = form;
  const multiple = isImageSlot(slot);
  const full = (slot === "video" && !!draft.assets.video) || (multiple && imageCount(slot, draft) >= 3);
  return <div className="mv-upload">
    <label className="mv-upload-button">{t(label)}<input aria-label={t(label)} type="file" accept={accept} multiple={multiple} disabled={busy || frozen || !ready || full} onChange={e => {
      const files = Array.from(e.target.files ?? []); e.target.value = "";
      if (files.length) handlers.onFiles(slot, files);
    }} /></label>
    {marketingAssetIds(draft.assets[slot]).map(id => {
      const item = materialFor(handlers.materials, slot, id);
      const refresh = () => handlers.onRefresh(id);
      return <div key={id} className="mv-asset-preview">
        {item && (item.mime.startsWith("audio/") ? <audio controls src={item.url} onError={refresh} aria-label={t("声音试听")} />
          : item.mime.startsWith("video/") ? <video controls preload="metadata" src={item.url} onError={refresh} aria-label={t("参考视频预览")} />
          : <img src={item.url} onError={refresh} alt={t(label)} />)}
        <span>{item?.name ?? t(label)}</span>
        <button disabled={busy || frozen} onClick={() => handlers.onRemove(slot, id)}>{t("移除")}</button>
        {(!item || item.issue) && <p className="mv-error">{t(!item ? "素材已不可用，请移除或替换后生成。" : "此历史素材不支持新生成，请移除或替换。")}</p>}
      </div>;
    })}
  </div>;
}

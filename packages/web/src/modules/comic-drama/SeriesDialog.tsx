import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ComicDramaSeries, ComicDramaSeriesInput } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { ChoiceSelect } from "./LibraryParts.js";

export type ComicDramaModel = { id: string; name?: string };

export function SeriesDialog({ series, models, close, save, error }: {
  series?: ComicDramaSeries;
  models: readonly ComicDramaModel[];
  close: () => void;
  save: (fields: ComicDramaSeriesInput) => Promise<boolean>;
  error: string | null;
}) {
  const { t, modelName } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const get = (name: string) => String(form.get(name) ?? "").trim();
    setBusy(true);
    try {
      if (await save({
        title: get("title"), logline: get("logline"), seriesGroup: get("seriesGroup") || null,
        episodeNo: get("episodeNo") ? Number(get("episodeNo")) : null, styleKey: get("styleKey"),
        aspectRatio: get("aspectRatio") as ComicDramaSeriesInput["aspectRatio"], videoModel: get("videoModel") || null,
      })) close();
    } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="comic-dialog" aria-labelledby="comic-dialog-title"
    onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={submit}>
      <h2 id="comic-dialog-title">{t(series ? "编辑剧集" : "新建剧集")}</h2>
      <fieldset disabled={busy}>
        <label>{t("剧集名称")}<input name="title" required maxLength={120} defaultValue={series?.title} autoFocus /></label>
        <label>{t("故事梗概")}<textarea name="logline" maxLength={2000} defaultValue={series?.logline} rows={3} /></label>
        <div className="comic-fields">
          <label>{t("所属系列")}<input name="seriesGroup" maxLength={120} defaultValue={series?.seriesGroup ?? ""} /></label>
          <label>{t("集数")}<input type="number" name="episodeNo" min={1} max={2147483647} defaultValue={series?.episodeNo ?? ""} /></label>
          <label>{t("画风")}<ChoiceSelect domain="style" name="styleKey" existing={series?.styleKey}
            defaultValue={series?.styleKey ?? "thick_painting"} required /></label>
          <label>{t("画幅")}<select name="aspectRatio" defaultValue={series?.aspectRatio ?? "9:16"}>
            <option>9:16</option><option>16:9</option><option>1:1</option>
          </select></label>
        </div>
        <label>{t("视频模型")}<select name="videoModel" defaultValue={series?.videoModel ?? ""}>
          <option value="">{t("稍后选择")}</option>
          {series?.videoModel && !models.some(model => model.id === series.videoModel) &&
            <option value={series.videoModel}>{series.videoModel}</option>}
          {models.map(model => <option key={model.id} value={model.id}>{modelName(model.name ?? model.id)}</option>)}
        </select></label>
        {error && <p className="comic-error" role="alert">{error}</p>}
        <div className="comic-actions">
          <button type="button" onClick={close}>{t("取消")}</button>
          <button className="primary" type="submit">{t(series ? "保存" : "创建并打开")}</button>
        </div>
      </fieldset>
    </form>
  </dialog>;
}

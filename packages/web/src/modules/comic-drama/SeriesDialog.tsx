import { useEffect, useRef, useState, type FormEvent } from "react";
import { comicVideoProfile, type ComicDramaListing, type ComicDramaSeries, type ComicDramaSeriesInput } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicDramaApi } from "./api.js";
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
  const [recent, setRecent] = useState<ComicDramaListing["entries"]>([]);
  const [sourceId, setSourceId] = useState("");
  const [inherit, setInherit] = useState(true);
  const [seriesGroup, setSeriesGroup] = useState(series?.seriesGroup ?? "");
  const [episodeNo, setEpisodeNo] = useState(series?.episodeNo ? String(series.episodeNo) : "");
  const [styleKey, setStyleKey] = useState(series?.styleKey ?? "thick_painting");
  const [aspectRatio, setAspectRatio] = useState<ComicDramaSeriesInput["aspectRatio"]>(series?.aspectRatio ?? "9:16");
  const [videoModel, setVideoModel] = useState(series?.videoModel ?? "");
  const available = models.filter(model => comicVideoProfile(model.id));

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (series) return;
    const controller = new AbortController();
    void comicDramaApi.list(new URLSearchParams({ archived: "false" }), controller.signal).then(data => {
      if (!controller.signal.aborted) setRecent(data.entries);
    }).catch(() => {});
    return () => controller.abort();
  }, [series]);

  const chooseSource = (id: string) => {
    setSourceId(id);
    const chosen = recent.find(item => item.id === id);
    if (!chosen) return;
    setSeriesGroup(chosen.seriesGroup ?? chosen.title);
    setEpisodeNo(String((chosen.episodeNo ?? 1) + 1));
    if (inherit) setStyleKey(chosen.styleKey);
    setAspectRatio(chosen.aspectRatio);
    if (chosen.videoModel) setVideoModel(chosen.videoModel);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const get = (name: string) => String(form.get(name) ?? "").trim();
    setBusy(true);
    try {
      if (await save({
        title: get("title"), logline: get("logline"), seriesGroup: seriesGroup.trim() || null,
        episodeNo: episodeNo.trim() ? Number(episodeNo) : null, styleKey,
        aspectRatio, videoModel: videoModel || null,
        ...(!series && sourceId ? { sourceSeriesId: sourceId, inheritCastAndStyle: inherit } : {}),
      })) close();
    } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="comic-dialog" aria-labelledby="comic-dialog-title"
    onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={submit}>
      <h2 id="comic-dialog-title">{t(series ? "编辑剧集" : "新建剧集")}</h2>
      <fieldset disabled={busy}>
        {!series && recent.length > 0 && <>
          <label>{t("沿用已有剧集（可选）")}<select value={sourceId} onChange={event => chooseSource(event.target.value)}>
            <option value="">{t("全新独立剧集")}</option>
            {recent.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.seriesGroup ? `${entry.seriesGroup} · ` : ""}{entry.title}{entry.episodeNo ? ` (#${entry.episodeNo})` : ""}
              </option>
            ))}
          </select></label>
          {sourceId && <label className="comic-sequel-option">
            <input type="checkbox" checked={inherit} onChange={event => {
              setInherit(event.target.checked);
              const chosen = recent.find(item => item.id === sourceId);
              if (event.target.checked && chosen) setStyleKey(chosen.styleKey);
            }} />
            {t("沿用上一集的角色与画风")}
          </label>}
        </>}
        <label>{t("剧集名称")}<input name="title" required maxLength={120} defaultValue={series?.title} autoFocus /></label>
        <label>{t("故事梗概")}<textarea name="logline" maxLength={2000} defaultValue={series?.logline} rows={3} /></label>
        <div className="comic-fields">
          <label>{t("所属系列")}<input name="seriesGroup" maxLength={120} value={seriesGroup}
            onChange={event => setSeriesGroup(event.target.value)} /></label>
          <label>{t("集数")}<input type="number" name="episodeNo" min={1} max={2147483647} value={episodeNo}
            onChange={event => setEpisodeNo(event.target.value)} /></label>
          <label>{t("画风")}<ChoiceSelect domain="style" name="styleKey" existing={series?.styleKey}
            value={styleKey} disabled={!series && !!sourceId && inherit} onChange={event => setStyleKey(event.target.value)} required /></label>
          <label>{t("画幅")}<select name="aspectRatio" value={aspectRatio}
            onChange={event => setAspectRatio(event.target.value as ComicDramaSeriesInput["aspectRatio"])}>
            <option>9:16</option><option>16:9</option><option>1:1</option>
          </select></label>
        </div>
        <label>{t("视频模型")}<select name="videoModel" value={videoModel} onChange={event => setVideoModel(event.target.value)}>
          <option value="">{t(series ? "稍后选择" : "沿用默认视频模型")}</option>
          {series?.videoModel && !available.some(model => model.id === series.videoModel) &&
            <option value={series.videoModel}>{series.videoModel}</option>}
          {available.map(model => <option key={model.id} value={model.id}>{modelName(model.name ?? model.id)}</option>)}
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

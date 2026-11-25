import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  comicVideoOptions, selectComicVideoModel, type ComicDramaSeries, type ComicDramaSeriesInput, type ComicDramaTreeEntry,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicDramaApi } from "./api.js";
import { comicLibraryApi } from "./library-api.js";
import { ChoiceSelect } from "./LibraryParts.js";

export type ComicDramaModel = { id: string; name?: string };
export type PresetDramaTarget = {
  id: string;
  title: string;
  styleKey: string;
  aspectRatio: ComicDramaSeriesInput["aspectRatio"];
  videoModel: string | null;
  nextEpisodeNo: number;
  latestEpisodeId?: string | null;
};

export function SeriesDialog({ series, presetDrama, models, close, save, error }: {
  series?: ComicDramaSeries;
  presetDrama?: PresetDramaTarget;
  models: readonly ComicDramaModel[];
  close: () => void;
  save: (fields: ComicDramaSeriesInput) => Promise<boolean>;
  error: string | null;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [dramas, setDramas] = useState<ComicDramaTreeEntry[]>([]);
  const [selectedDramaId, setSelectedDramaId] = useState(series?.dramaId ?? presetDrama?.id ?? "__new__");
  const [dramaTitle, setDramaTitle] = useState("");
  const [sourceId, setSourceId] = useState(presetDrama?.latestEpisodeId ?? "");
  const [inherit, setInherit] = useState(true);
  const [episodeNo, setEpisodeNo] = useState(
    series?.episodeNo ? String(series.episodeNo) : presetDrama ? String(presetDrama.nextEpisodeNo) : "1",
  );
  const [styleKey, setStyleKey] = useState(series?.styleKey ?? presetDrama?.styleKey ?? "thick_painting");
  const [aspectRatio, setAspectRatio] = useState<ComicDramaSeriesInput["aspectRatio"]>(
    series?.aspectRatio ?? presetDrama?.aspectRatio ?? "9:16",
  );
  const [videoModel, setVideoModel] = useState(
    series?.videoModel ?? presetDrama?.videoModel ?? selectComicVideoModel(models) ?? "",
  );
  const [preferredVideo, setPreferredVideo] = useState<string | null>(null);
  const videoTouched = useRef(false);
  const available = comicVideoOptions(models, videoModel);

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void comicDramaApi.listDramas(new URLSearchParams({ archived: "false" }), controller.signal).then(data => {
      if (!controller.signal.aborted) setDramas(data.dramas);
    }).catch(() => {});
    if (!series) {
      void comicLibraryApi.settings(controller.signal).then(data => {
        if (!controller.signal.aborted) setPreferredVideo(data.preferences.defaultVideoModel ?? null);
      }).catch(() => {});
    }
    return () => controller.abort();
  }, [series]);
  // New episodes start on the default from settings, else Seedance 2.0, until the user picks a model.
  useEffect(() => {
    if (!series && !presetDrama && !videoTouched.current) {
      setVideoModel(selectComicVideoModel(models, preferredVideo) ?? "");
    }
  }, [series, presetDrama, models, preferredVideo]);
  const chooseVideoModel = (id: string) => {
    videoTouched.current = true;
    setVideoModel(id);
  };

  const selectedDrama = dramas.find(d => d.id === selectedDramaId);
  const dramaEpisodes = selectedDrama?.episodes ?? [];

  const chooseDrama = (dramaId: string) => {
    setSelectedDramaId(dramaId);
    if (dramaId === "__new__") {
      setSourceId("");
      setEpisodeNo("1");
      return;
    }
    const chosen = dramas.find(item => item.id === dramaId);
    if (!chosen) return;
    if (!series) {
      const nextNo = chosen.episodes.reduce((max, ep) => Math.max(max, ep.episodeNo), 0) + 1;
      setEpisodeNo(String(nextNo));
      const latestEp = chosen.episodes.at(-1);
      setSourceId(latestEp?.id ?? "");
      if (inherit) setStyleKey(chosen.styleKey);
      setAspectRatio(chosen.aspectRatio);
      const inherited = comicVideoOptions(models, chosen.videoModel).find(model => model.id === chosen.videoModel)?.id;
      chooseVideoModel(inherited ?? selectComicVideoModel(models, preferredVideo) ?? "");
    }
  };

  const chooseSource = (id: string) => {
    setSourceId(id);
    const chosen = dramaEpisodes.find(item => item.id === id);
    if (!chosen || !selectedDrama) return;
    setEpisodeNo(String(Math.max(chosen.episodeNo + 1, dramaEpisodes.reduce((max, ep) => Math.max(max, ep.episodeNo), 0) + 1)));
    if (inherit) setStyleKey(selectedDrama.styleKey);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const get = (name: string) => String(form.get(name) ?? "").trim();
    const isExistingDrama = selectedDramaId !== "__new__";
    const resolvedDramaTitle = isExistingDrama
      ? (selectedDrama?.title ?? presetDrama?.title ?? series?.seriesGroup ?? null)
      : (dramaTitle.trim() || null);
    setBusy(true);
    try {
      if (await save({
        title: get("title"),
        logline: get("logline"),
        ...(isExistingDrama ? { dramaId: selectedDramaId } : {}),
        ...(resolvedDramaTitle && !isExistingDrama ? { dramaTitle: resolvedDramaTitle } : {}),
        seriesGroup: resolvedDramaTitle,
        episodeNo: episodeNo.trim() ? Number(episodeNo) : 1,
        styleKey,
        aspectRatio,
        videoModel: videoModel || null,
        ...(!series && sourceId ? { sourceSeriesId: sourceId, inheritCastAndStyle: inherit } : {}),
      })) close();
    } finally { setBusy(false); }
  }

  return (
    <dialog ref={dialog} className="comic-dialog" aria-labelledby="comic-dialog-title"
      onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
      <form onSubmit={submit}>
        <h2 id="comic-dialog-title">{t(series ? "编辑剧集" : presetDrama ? "新增分集" : "新建剧集")}</h2>
        <fieldset disabled={busy}>
          <label>{t("所属整部剧集")}
            <select aria-label={t("所属整部剧集")} value={selectedDramaId} onChange={event => chooseDrama(event.target.value)}>
              {!series && <option value="__new__">{t("新建整部剧集")}</option>}
              {presetDrama && !dramas.some(d => d.id === presetDrama.id) && (
                <option value={presetDrama.id}>{presetDrama.title}</option>
              )}
              {series && !dramas.some(d => d.id === series.dramaId) && (
                <option value={series.dramaId}>{series.seriesGroup ?? series.title}</option>
              )}
              {dramas.map(entry => (
                <option key={entry.id} value={entry.id}>
                  {entry.title}（{t("共 {0} 集", [entry.episodeCount])}）
                </option>
              ))}
            </select>
          </label>
          {!series && selectedDramaId === "__new__" && (
            <label>{t("整部剧集名称")}
              <input name="dramaTitle" maxLength={120} value={dramaTitle}
                placeholder={t("留空则与本集名称一致")} onChange={event => setDramaTitle(event.target.value)} />
            </label>
          )}
          {!series && selectedDramaId !== "__new__" && dramaEpisodes.length > 0 && (
            <>
              <label>{t("沿用本剧已有分集（可选）")}
                <select value={sourceId} onChange={event => chooseSource(event.target.value)}>
                  <option value="">{t("不沿用已有分集")}</option>
                  {dramaEpisodes.map(ep => (
                    <option key={ep.id} value={ep.id}>
                      {t("第 {0} 集", [ep.episodeNo])} · {ep.title}
                    </option>
                  ))}
                </select>
              </label>
              {sourceId && (
                <label className="comic-sequel-option">
                  <input type="checkbox" checked={inherit} onChange={event => {
                    setInherit(event.target.checked);
                    if (event.target.checked && selectedDrama) setStyleKey(selectedDrama.styleKey);
                  }} />
                  {t("沿用上一集的角色与画风")}
                </label>
              )}
            </>
          )}
          <label>{t("剧集名称")}<input name="title" required maxLength={120} defaultValue={series?.title} autoFocus /></label>
          <label>{t("故事梗概")}<textarea name="logline" maxLength={2000} defaultValue={series?.logline} rows={3} /></label>
          <div className="comic-fields">
            <label>{t("集数")}
              <input type="number" name="episodeNo" min={1} max={2147483647} value={episodeNo}
                onChange={event => setEpisodeNo(event.target.value)} />
            </label>
            <label>{t("画风")}
              <ChoiceSelect domain="style" name="styleKey" existing={series?.styleKey}
                value={styleKey} disabled={!series && !!sourceId && inherit}
                onChange={event => setStyleKey(event.target.value)} required />
            </label>
            <label>{t("画幅")}
              <select name="aspectRatio" value={aspectRatio}
                onChange={event => setAspectRatio(event.target.value as ComicDramaSeriesInput["aspectRatio"])}>
                <option>9:16</option><option>16:9</option><option>1:1</option>
              </select>
            </label>
          </div>
          <label>{t("视频模型")}
            <select name="videoModel" value={videoModel} onChange={event => chooseVideoModel(event.target.value)}>
              {(series ? !series.videoModel : !available.length) && (
                <option value="">{t(series ? "稍后选择" : "沿用默认视频模型")}</option>
              )}
              {series?.videoModel && !available.some(model => model.id === series.videoModel) && (
                <option value={series.videoModel}>{series.videoModel}</option>
              )}
              {available.map(model => <option key={model.id} value={model.id}>{t(model.label)}</option>)}
            </select>
          </label>
          {error && <p className="comic-error" role="alert">{error}</p>}
          <div className="comic-actions">
            <button type="button" onClick={close}>{t("取消")}</button>
            <button className="primary" type="submit">{t(series ? "保存" : "创建并打开")}</button>
          </div>
        </fieldset>
      </form>
    </dialog>
  );
}

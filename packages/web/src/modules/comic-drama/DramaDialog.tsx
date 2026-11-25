import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  comicVideoOptions, selectComicVideoModel,
  type ComicDrama, type ComicDramaCreateInput, type ComicDramaSeriesInput, type ComicDramaUpdateInput,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import type { ComicDramaModel } from "./SeriesDialog.js";
import { comicLibraryApi } from "./library-api.js";
import { ChoiceSelect } from "./LibraryParts.js";

export function DramaDialog({
  drama, models, close, save, error,
}: {
  drama?: ComicDrama;
  models: readonly ComicDramaModel[];
  close: () => void;
  save: (fields: ComicDramaCreateInput | ComicDramaUpdateInput) => Promise<boolean>;
  error: string | null;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [styleKey, setStyleKey] = useState(drama?.styleKey ?? "thick_painting");
  const [aspectRatio, setAspectRatio] = useState<ComicDramaSeriesInput["aspectRatio"]>(drama?.aspectRatio ?? "9:16");
  const [videoModel, setVideoModel] = useState(drama?.videoModel ?? selectComicVideoModel(models) ?? "");
  const [preferredVideo, setPreferredVideo] = useState<string | null>(null);
  const videoTouched = useRef(false);
  const available = comicVideoOptions(models, videoModel);

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (drama) return;
    const controller = new AbortController();
    void comicLibraryApi.settings(controller.signal).then(data => {
      if (!controller.signal.aborted) setPreferredVideo(data.preferences.defaultVideoModel ?? null);
    }).catch(() => {});
    return () => controller.abort();
  }, [drama]);
  useEffect(() => {
    if (!drama && !videoTouched.current) setVideoModel(selectComicVideoModel(models, preferredVideo) ?? "");
  }, [drama, models, preferredVideo]);

  const chooseVideoModel = (id: string) => {
    videoTouched.current = true;
    setVideoModel(id);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const get = (name: string) => String(form.get(name) ?? "").trim();
    setBusy(true);
    try {
      const payload = drama
        ? {
          title: get("title"),
          synopsis: get("synopsis"),
          styleKey,
          aspectRatio,
          videoModel: videoModel || null,
          expectedRevision: drama.revision,
        }
        : {
          title: get("title"),
          synopsis: get("synopsis"),
          styleKey,
          aspectRatio,
          videoModel: videoModel || null,
          firstEpisodeTitle: get("firstEpisodeTitle") || undefined,
        };
      if (await save(payload)) close();
    } finally { setBusy(false); }
  }

  return (
    <dialog ref={dialog} className="comic-dialog" aria-labelledby="comic-drama-dialog-title"
      onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
      <form onSubmit={submit}>
        <h2 id="comic-drama-dialog-title">{t(drama ? "编辑整部剧集" : "新建整部剧集")}</h2>
        <fieldset disabled={busy}>
          <label>{t("整部剧集名称")}
            <input name="title" required maxLength={120} defaultValue={drama?.title} autoFocus />
          </label>
          <label>{t("整部剧集简介")}
            <textarea name="synopsis" maxLength={2000} defaultValue={drama?.synopsis} rows={3} />
          </label>
          {!drama && (
            <label>{t("第 1 集名称（可选）")}
              <input name="firstEpisodeTitle" maxLength={120} placeholder={t("留空则与整部剧集同名")} />
            </label>
          )}
          <div className="comic-fields">
            <label>{t("默认画风")}
              <ChoiceSelect domain="style" name="styleKey" existing={drama?.styleKey}
                value={styleKey} onChange={event => setStyleKey(event.target.value)} required />
            </label>
            <label>{t("默认画幅")}
              <select name="aspectRatio" value={aspectRatio}
                onChange={event => setAspectRatio(event.target.value as ComicDramaSeriesInput["aspectRatio"])}>
                <option>9:16</option><option>16:9</option><option>1:1</option>
              </select>
            </label>
          </div>
          <label>{t("默认视频模型")}
            <select name="videoModel" value={videoModel} onChange={event => chooseVideoModel(event.target.value)}>
              {(drama ? !drama.videoModel : !available.length) && (
                <option value="">{t(drama ? "稍后选择" : "沿用默认视频模型")}</option>
              )}
              {drama?.videoModel && !available.some(model => model.id === drama.videoModel) && (
                <option value={drama.videoModel}>{drama.videoModel}</option>
              )}
              {available.map(model => <option key={model.id} value={model.id}>{t(model.label)}</option>)}
            </select>
          </label>
          {error && <p className="comic-error" role="alert">{error}</p>}
          <div className="comic-actions">
            <button type="button" onClick={close}>{t("取消")}</button>
            <button className="primary" type="submit">{t(drama ? "保存" : "创建并打开")}</button>
          </div>
        </fieldset>
      </form>
    </dialog>
  );
}

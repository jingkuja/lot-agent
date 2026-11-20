import { useEffect, useState } from "react";
import { comicVideoProfile, type ComicUserPreferences, type ComicUserSettings } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { DictionarySettings } from "./DictionarySettings.js";
import { comicLibraryApi } from "./library-api.js";
import { libraryError, MediaPreview, useComicChoices } from "./LibraryParts.js";
import type { ComicDramaModel } from "./SeriesDialog.js";

const images = "image/jpeg,image/png,image/webp";

export function ComicSettingsPage({
  videoModels,
  imageModels = [],
  llmModels = [],
}: {
  videoModels: readonly ComicDramaModel[];
  imageModels?: readonly ComicDramaModel[];
  llmModels?: readonly ComicDramaModel[];
}) {
  const { t, locale, modelName } = useI18n();
  const [tab, setTab] = useState<"styles" | "models" | "dictionary">("styles");
  const [settings, setSettings] = useState<ComicUserSettings | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const styles = useComicChoices("style", refresh);
  const eligibleVideos = videoModels.filter(model => comicVideoProfile(model.id));

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void comicLibraryApi.settings(controller.signal).then(data => {
      if (!controller.signal.aborted) setSettings(data);
    }).catch(reason => { if (!controller.signal.aborted) setError(libraryError(reason)); });
    return () => controller.abort();
  }, [refresh]);

  const [prefs, setPrefs] = useState<ComicUserPreferences>({});
  useEffect(() => {
    if (settings) setPrefs(settings.preferences);
  }, [settings]);

  const saveModels = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await comicLibraryApi.updateSettings({
        defaultVideoModel: prefs.defaultVideoModel || null,
        defaultImageModel: prefs.defaultImageModel || null,
        defaultTextModel: prefs.defaultTextModel || null,
      });
      setPrefs(next);
      setSettings(cur => cur ? { ...cur, preferences: next } : cur);
      setNotice("默认模型设置已保存");
    } catch (reason) {
      setError(libraryError(reason));
    } finally {
      setBusy(false);
    }
  };

  const uploadStyleRef = async (styleKey: string, file: File) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const preset = await comicLibraryApi.uploadStyleReference(styleKey, file, AbortSignal.timeout(30_000));
      setSettings(cur => cur ? {
        ...cur,
        stylePresets: [...cur.stylePresets.filter(item => item.styleKey !== styleKey), preset],
      } : cur);
      setNotice("画风参考图已更新");
    } catch (reason) {
      setError(libraryError(reason));
    } finally {
      setBusy(false);
    }
  };

  const removeStyleRef = async (styleKey: string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await comicLibraryApi.removeStyleReference(styleKey);
      setSettings(cur => cur ? {
        ...cur,
        stylePresets: cur.stylePresets.filter(item => item.styleKey !== styleKey),
      } : cur);
      setNotice("已移除画风参考图");
    } catch (reason) {
      setError(libraryError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="comic-heading"><h1>{t("设置")}</h1></header>
      <nav className="comic-steps" aria-label={t("设置")}>
        <button type="button" aria-pressed={tab === "styles"} onClick={() => setTab("styles")}>{t("画风预设")}</button>
        <button type="button" aria-pressed={tab === "models"} onClick={() => setTab("models")}>{t("默认模型")}</button>
        <button type="button" aria-pressed={tab === "dictionary"} onClick={() => setTab("dictionary")}>{t("数据字典")}</button>
      </nav>
      {error && <p className="comic-error" role="alert">{t(error)}</p>}
      {notice && <p className="comic-generation-note" role="status">{t(notice)}</p>}

      {tab === "styles" && (
        <section className="comic-edit-card">
          <header>
            <h2>{t("画风预设与参考图")}</h2>
            <button type="button" onClick={() => setTab("dictionary")}>{t("管理画风字典")}</button>
          </header>
          <p className="comic-generation-note">{t("为画风绑定参考图后，该画风剧集生成首帧和视频时会自动带入参考图。")}</p>
          <div className="comic-library-grid">
            {styles.filter(entry => !entry.inactive).map(entry => {
              const bound = settings?.stylePresets.find(item => item.styleKey === entry.key);
              return (
                <article className="comic-library-card" key={entry.key}>
                  {bound ? <MediaPreview media={bound.media} title={entry.labels[locale]} openOriginal /> : (
                    <div className="comic-media-well comic-character-initial" aria-hidden="true">{entry.labels[locale].slice(0, 2)}</div>
                  )}
                  <strong>{entry.labels[locale]}</strong>
                  <small><code>{entry.key}</code> · {bound ? t("已绑定参考图") : t("未绑定参考图")}</small>
                  <div className="comic-actions">
                    <label className="comic-file-button">
                      {t(bound ? "更换参考图" : "上传参考图")}
                      <input type="file" accept={images} disabled={busy} hidden onChange={event => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void uploadStyleRef(entry.key, file);
                      }} />
                    </label>
                    {bound && (
                      <button type="button" disabled={busy} onClick={() => void removeStyleRef(entry.key)}>{t("移除参考图")}</button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {tab === "models" && (
        <section className="comic-edit-card">
          <header><h2>{t("默认模型设置")}</h2></header>
          <p className="comic-generation-note">{t("新建剧集、生成首帧及使用导演助手时优先采用以下默认模型；留空则沿用平台默认策略。")}</p>
          <fieldset className="comic-clip-fields" disabled={busy || !settings}>
            <div className="comic-fields">
              <label>
                {t("默认视频模型")}
                <select value={prefs.defaultVideoModel ?? ""} onChange={event => setPrefs(cur => ({ ...cur, defaultVideoModel: event.target.value || null }))}>
                  <option value="">{t("沿用系统默认")}</option>
                  {eligibleVideos.map(model => <option key={model.id} value={model.id}>{modelName(model.name ?? model.id)}</option>)}
                </select>
              </label>
              <label>
                {t("默认图片模型")}
                <select value={prefs.defaultImageModel ?? ""} onChange={event => setPrefs(cur => ({ ...cur, defaultImageModel: event.target.value || null }))}>
                  <option value="">{t("沿用系统默认")}</option>
                  {imageModels.map(model => <option key={model.id} value={model.id}>{modelName(model.name ?? model.id)}</option>)}
                </select>
              </label>
              <label>
                {t("默认导演文字模型")}
                <select value={prefs.defaultTextModel ?? ""} onChange={event => setPrefs(cur => ({ ...cur, defaultTextModel: event.target.value || null }))}>
                  <option value="">{t("沿用用户默认文字模型")}</option>
                  {llmModels.map(model => <option key={model.id} value={model.id}>{modelName(model.name ?? model.id)}</option>)}
                </select>
              </label>
            </div>
            <div className="comic-actions">
              <button type="button" className="primary" onClick={() => void saveModels()}>{t("保存设置")}</button>
              <button type="button" onClick={() => setRefresh(v => v + 1)}>{t("重新读取")}</button>
            </div>
          </fieldset>
        </section>
      )}

      {tab === "dictionary" && <DictionarySettings />}
    </>
  );
}

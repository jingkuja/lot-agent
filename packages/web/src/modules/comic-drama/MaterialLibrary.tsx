import { useCallback, useEffect, useState } from "react";
import { comicMaterialKinds, type ComicMaterial, type ComicMaterialKind } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicLibraryApi } from "./library-api.js";
import { ChoiceSelect, comicListWords, LibraryDialog, libraryError, LibraryPagination, LibrarySearch, MediaPreview, MediaVersions, useComicChoices } from "./LibraryParts.js";

export const comicMaterialLabels = { scene: "场景", prop: "道具", sound: "音效", music: "背景音乐", other: "其他" } as const;
const images = "image/jpeg,image/png,image/webp";
const audio = ".mp3,.wav,audio/mpeg,audio/wav";
const options = {
  scene: { accept: images, hint: "JPG、PNG 或 WebP，最多 20 MB" },
  prop: { accept: images, hint: "JPG、PNG 或 WebP，最多 20 MB" },
  sound: { accept: audio, hint: "MP3 或 WAV，最多 15 MB / 30 秒" },
  music: { accept: audio, hint: "MP3 或 WAV，最多 30 MB / 5 分钟" },
  other: { accept: images + "," + audio, hint: "图片最多 20 MB，音频最多 30 MB / 5 分钟" },
};

export function MaterialLibrary() {
  const { locale, t } = useI18n();
  const [kind, setKind] = useState<ComicMaterialKind>("scene");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState<Awaited<ReturnType<typeof comicLibraryApi.materials>> | "error" | null>(null);
  const [uploading, setUploading] = useState<"new" | ComicMaterial | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const choices = useComicChoices(kind);
  const reload = () => setRefresh(i => i + 1);
  useEffect(() => {
    const controller = new AbortController();
    setList(null);
    void comicLibraryApi.materials({ kind, query, archived: String(archived), page: String(page) }, controller.signal).then(rows => {
      if (!controller.signal.aborted) setList(rows);
    }).catch(() => { if (!controller.signal.aborted) setList("error"); });
    return () => controller.abort();
  }, [kind, query, archived, page, refresh]);
  const versions = useCallback((signal: AbortSignal) => versionId ?
    comicLibraryApi.materialVersions(versionId, signal) : Promise.resolve([]), [versionId]);

  return <>
    <header className="comic-heading"><h1>{t("素材库")}</h1>
      <button className="primary" onClick={() => setUploading("new")}>＋ {t("上传素材")}</button>
    </header>
    <nav className="comic-steps" aria-label={t("素材分类")}>
      {comicMaterialKinds.map(value => <button key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setPage(1); }}>
        {t(comicMaterialLabels[value])}</button>)}
    </nav>
    <LibrarySearch query={query} search={value => { setQuery(value); setPage(1); }} archived={archived}
      onArchived={value => { setArchived(value); setPage(1); }} />
    {error && <p className="comic-error" role="alert">{t(error)}</p>}
    {list === "error" ? <button onClick={reload}>{t("重新读取")}</button> : list ? <>
      {list.entries.length === 0 && <div className="comic-empty">{t("暂无匹配的素材")}</div>}
      <div className="comic-library-grid">{list.entries.map(material => <article className="comic-library-card" key={material.id}>
        <MediaPreview key={material.media.id} media={material.media} title={material.name} />
        <strong>{material.name}</strong>
        <small>{[choices.find(entry => entry.key === material.categoryKey)?.labels[locale] ?? material.categoryKey,
          ...material.tags, t("版本 {0}", [material.version])].filter(Boolean).join(" · ")}</small>
        <div className="comic-actions">
          <button onClick={() => setVersionId(material.id)}>{t("版本历史")}</button>
          {!material.archived && <>
            <button onClick={() => setUploading(material)}>{t("替换文件")}</button>
            <button onClick={() => {
              if (window.confirm(t("归档此素材？"))) void comicLibraryApi.archiveMaterial(material.id)
                .then(reload).catch(reason => setError(libraryError(reason)));
            }}>{t("归档")}</button>
          </>}
        </div>
      </article>)}</div>
      <LibraryPagination page={page} more={list.more} change={setPage} />
    </> : <p role="status">{t("加载中…")}</p>}
    {uploading && <MaterialUpload initialKind={kind} material={uploading === "new" ? undefined : uploading}
      close={() => setUploading(null)} done={nextKind => {
        if (uploading === "new") { setKind(nextKind); setArchived(false); setQuery(""); setPage(1); }
        reload();
      }} />}
    {versionId && <MediaVersions list={versions} close={() => setVersionId(null)} />}
  </>;
}

function MaterialUpload({ initialKind, material, close, done }: {
  initialKind: ComicMaterialKind;
  material?: ComicMaterial;
  close: () => void;
  done: (kind: ComicMaterialKind) => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState(material?.kind ?? initialKind);
  return <LibraryDialog title={t(material ? "替换文件" : "上传素材")} submitLabel={t("上传")} close={close} save={async (form, signal) => {
    const file = form.get("file") as File;
    if (material) await comicLibraryApi.replaceMaterial(material.id, file, signal);
    else await comicLibraryApi.materialUpload({
      kind, name: String(form.get("name") ?? "").trim(), categoryKey: String(form.get("category") ?? "") || null,
      tags: comicListWords(String(form.get("tags") ?? "")),
    }, file, signal);
    if (!signal.aborted) done(kind);
  }}>
    {material ? <strong>{material.name}</strong> : <>
      <label>{t("素材名称")}<input name="name" autoFocus required maxLength={120} /></label>
      <div className="comic-fields">
        <label>{t("素材分类")}<select value={kind} onChange={event => setKind(event.target.value as ComicMaterialKind)}>
          {comicMaterialKinds.map(value => <option key={value} value={value}>{t(comicMaterialLabels[value])}</option>)}
        </select></label>
        <label>{t("分类")}<ChoiceSelect key={kind} domain={kind} name="category" aria-label={t("分类")} empty={t("未分类")} /></label>
      </div>
      <label>{t("标签")}<input name="tags" maxLength={2400} placeholder={t("用逗号分隔")} /></label>
    </>}
    <label>{t("选择文件")}<input key={kind} name="file" required type="file" accept={options[kind].accept} /></label>
    <small>{t(options[kind].hint)}</small>
  </LibraryDialog>;
}

import { useCallback, useEffect, useState } from "react";
import { comicMaterialKinds, type ComicMaterial, type ComicMaterialImageKind, type ComicMaterialKind } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicLibraryApi } from "./library-api.js";
import { ChoiceSelect, comicListWords, LibraryDialog, libraryError, LibraryPagination, LibrarySearch, MediaPreview, MediaVersions, useComicChoices } from "./LibraryParts.js";
import { comicGenerationApi } from "./generation-api.js";
import { ComicTakeStatus, hasActiveComicTakes, ImageTakeActions, useGenerationHistory } from "./GenerationHistory.js";
import { comicGenerationError } from "./GenerationQuoteDialog.js";
import { MaterialImageGeneration } from "./MaterialImageGeneration.js";
import { ComicVoiceLibrary } from "./ComicVoiceLibrary.js";

export const comicMaterialLabels = { scene: "场景", prop: "道具", sound: "音效", music: "背景音乐", other: "其他" } as const;
const materialTabs = ["scene", "prop", "voice", "sound", "music", "other"] as const;
const images = "image/jpeg,image/png,image/webp";
const audio = ".mp3,.wav,audio/mpeg,audio/wav";
const options = {
  scene: { accept: images, hint: "JPG、PNG 或 WebP，最多 20 MB" },
  prop: { accept: images, hint: "JPG、PNG 或 WebP，最多 20 MB" },
  sound: { accept: audio, hint: "MP3 或 WAV，最多 15 MB / 30 秒" },
  music: { accept: audio, hint: "MP3 或 WAV，最多 30 MB / 5 分钟" },
  other: {
    accept: `${images},${audio},.mp4,.mov,video/mp4,video/quicktime`,
    hint: "图片最多 20 MB，音频最多 30 MB / 5 分钟，MP4 或 MOV 最多 200 MB / 5 分钟",
  },
};
const isImageKind = (kind: ComicMaterialKind): kind is ComicMaterialImageKind => kind === "scene" || kind === "prop";
const isImageMaterial = (material: ComicMaterial): material is ComicMaterial & { kind: ComicMaterialImageKind } => isImageKind(material.kind);

export function MaterialLibrary({ initialVoiceTab = false }: { initialVoiceTab?: boolean } = {}) {
  const { locale, t } = useI18n();
  const [kind, setKind] = useState<ComicMaterialKind>("scene");
  const [voiceTab, setVoiceTab] = useState(initialVoiceTab);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState<Awaited<ReturnType<typeof comicLibraryApi.materials>> | "error" | null>(null);
  const [uploading, setUploading] = useState<"new" | ComicMaterial | null>(null);
  const [editing, setEditing] = useState<ComicMaterial | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [generating, setGenerating] = useState<{ kind: ComicMaterialImageKind; material?: ComicMaterial } | null>(null);
  const [error, setError] = useState("");
  const choices = useComicChoices(kind);
  const reload = () => setRefresh(i => i + 1);
  const generation = useGenerationHistory(comicGenerationApi.materialTakes, 5_000, 0, {
    shouldPoll: data => hasActiveComicTakes(data),
  });
  const readyKey = generation.current?.filter(take => take.state === "ready").map(take => take.id).join(",");
  useEffect(() => { if (readyKey) setRefresh(value => value + 1); }, [readyKey]);
  useEffect(() => {
    if (voiceTab) return;
    const controller = new AbortController();
    setList(null);
    void comicLibraryApi.materials({ kind, query, archived: String(archived), page: String(page) }, controller.signal).then(rows => {
      if (!controller.signal.aborted) setList(rows);
    }).catch(() => { if (!controller.signal.aborted) setList("error"); });
    return () => controller.abort();
  }, [kind, query, archived, page, refresh, voiceTab]);
  const versions = useCallback((signal: AbortSignal) => versionId ?
    comicLibraryApi.materialVersions(versionId, signal) : Promise.resolve([]), [versionId]);
  const tabs = <nav className="comic-steps" aria-label={t("素材分类")}>
    {materialTabs.map(value => value === "voice" ? (
      <button key={value} type="button" aria-pressed={voiceTab} onClick={() => setVoiceTab(true)}>{t("人物配音")}</button>
    ) : (
      <button key={value} type="button" aria-pressed={!voiceTab && kind === value} onClick={() => {
        setVoiceTab(false);
        setKind(value);
        setPage(1);
      }}>{t(comicMaterialLabels[value])}</button>
    ))}
  </nav>;

  if (voiceTab) return <ComicVoiceLibrary tabs={tabs} />;

  return <>
    <header className="comic-heading comic-material-heading"><h1>{t("素材库")}</h1>
      <div className="comic-actions">
        {isImageKind(kind) && !archived && <button type="button" onClick={() => setGenerating({ kind })}>{t("生成素材图片")}</button>}
        <button className="primary" onClick={() => setUploading("new")}>＋ {t("上传素材")}</button>
      </div>
    </header>
    {tabs}
    <LibrarySearch query={query} search={value => { setQuery(value); setPage(1); }} archived={archived}
      onArchived={value => { setArchived(value); setPage(1); }} />
    {(!!generation.current?.length || generation.failed) && <details className="comic-edit-card">
      <summary>{t("素材图片任务")}</summary>
      {generation.failed && <button type="button" onClick={generation.refresh}>{t("重新读取")}</button>}
      <ul className="comic-generation-status-list">{generation.current?.map(take => <li key={take.id}>
        <strong>{take.materialName}</strong><ComicTakeStatus take={take} />
        <ImageTakeActions take={take} refreshed={generation.refresh} />
      </li>)}</ul>
    </details>}
    {error && <p className="comic-error" role="alert">{t(error)}</p>}
    {list === "error" ? <button onClick={reload}>{t("重新读取")}</button> : list ? <>
      {list.entries.length === 0 && <div className="comic-empty">{t("暂无匹配的素材")}</div>}
      <div className="comic-library-grid">{list.entries.map(material => <article className="comic-library-card" key={material.id}>
        <MediaPreview key={material.media.id} media={material.media} title={material.name} />
        <strong>{material.name}</strong>
        <small>{[choices.find(entry => entry.key === material.categoryKey)?.labels[locale] ?? material.categoryKey,
          ...material.tags, t("版本 {0}", [material.version])].filter(Boolean).join(" · ")}</small>
        <div className="comic-actions">
          <button type="button" onClick={() => setVersionId(material.id)}>{t("版本历史")}</button>
          {!material.archived ? <>
            <button type="button" onClick={() => setEditing(material)}>{t("编辑")}</button>
            <button type="button" onClick={() => setUploading(material)}>{t("替换文件")}</button>
            <button type="button" onClick={() => {
              if (window.confirm(t("归档此素材？"))) void comicLibraryApi.archiveMaterial(material.id)
                .then(reload).catch(reason => setError(libraryError(reason)));
            }}>{t("归档")}</button>
          </> : (
            <button type="button" onClick={() => void comicLibraryApi.unarchiveMaterial(material.id)
              .then(reload).catch(reason => setError(libraryError(reason)))}>{t("取消归档")}</button>
          )}
          {!material.archived && isImageMaterial(material) && <button type="button" onClick={() => {
            setGenerating({ kind: material.kind, material });
          }}>{t("生成图片")}</button>}
          <button type="button" onClick={() => {
            if (window.confirm(t("彻底删除此素材？已被剪辑或画风参考使用的素材无法删除。"))) void comicLibraryApi.deleteMaterial(material.id)
              .then(reload).catch(reason => setError(comicGenerationError(reason)));
          }}>{t("删除")}</button>
        </div>
      </article>)}</div>
      <LibraryPagination page={page} more={list.more} change={setPage} />
    </> : <p role="status">{t("加载中…")}</p>}
    {editing && <LibraryDialog title={t("编辑素材")} submitLabel={t("保存")} close={() => setEditing(null)} save={async form => {
      await comicLibraryApi.editMaterial(editing.id, {
        name: String(form.get("name") ?? "").trim(),
        categoryKey: String(form.get("category") ?? "") || null,
        tags: comicListWords(String(form.get("tags") ?? "")),
      });
      reload();
    }}>
      <label>{t("素材名称")}<input name="name" autoFocus required maxLength={120} defaultValue={editing.name} /></label>
      <label>{t("分类")}<ChoiceSelect domain={editing.kind} name="category" aria-label={t("分类")} existing={editing.categoryKey}
        defaultValue={editing.categoryKey ?? ""} empty={t("未分类")} /></label>
      <label>{t("标签")}<input name="tags" maxLength={2400} defaultValue={editing.tags.join(", ")} placeholder={t("用逗号分隔")} /></label>
    </LibraryDialog>}
    {uploading && <MaterialUpload initialKind={kind} material={uploading === "new" ? undefined : uploading}
      close={() => setUploading(null)} done={nextKind => {
        if (uploading === "new") { setKind(nextKind); setArchived(false); setQuery(""); setPage(1); }
        reload();
      }} />}
    {versionId && <MediaVersions list={versions} close={() => setVersionId(null)} />}
    {generating && <MaterialImageGeneration {...generating} close={() => setGenerating(null)} submitted={generation.refresh} />}
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

import { useEffect, useState } from "react";
import type { ComicCastChange, ComicCharacterDetail, ComicSeriesCast } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicDramaApi } from "./api.js";
import { CharacterFormDialog, useComicDramaOptions } from "./CharacterFormDialog.js";
import { comicLibraryApi } from "./library-api.js";
import { LibraryDialog, LibraryPagination, MediaPreview, useComicChoices } from "./LibraryParts.js";

export function CastPanel({
  seriesId, dramaId, dramaTitle, revision, cast, disabled, change, scope = "episode", dramaCastCount = 0, onSyncDramaCast, onOpenLibrary,
}: {
  seriesId: string;
  dramaId?: string;
  dramaTitle?: string;
  revision: number;
  cast: ComicSeriesCast[];
  disabled: boolean;
  change: (action: ComicCastChange) => Promise<boolean>;
  scope?: "episode" | "drama";
  dramaCastCount?: number;
  onSyncDramaCast?: () => Promise<boolean>;
  onOpenLibrary?: (characterId?: string) => void;
}) {
  const { t, locale } = useI18n();
  const [edit, setEdit] = useState<ComicSeriesCast | "new" | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState<{ cast: ComicSeriesCast[]; revision: number } | "failed" | null>(null);
  const slots = useComicChoices("slot");
  const expressions = useComicChoices("expression");
  const isDrama = scope === "drama";
  const effectiveDramaId = dramaId ?? (isDrama ? seriesId : undefined);
  useEffect(() => {
    const focus = () => setRefresh(value => value + 1);
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    const load = isDrama
      ? comicDramaApi.dramaCast(seriesId, controller.signal).then(res => ({ cast: res.cast, revision: res.dramaRevision }))
      : comicDramaApi.cast(seriesId, controller.signal).then(res => ({ cast: res.cast, revision: res.seriesRevision }));
    void load.then(result => {
      if (!controller.signal.aborted) setStatus(result);
    }).catch(() => { if (!controller.signal.aborted) setStatus("failed"); });
    return () => controller.abort();
  }, [isDrama, seriesId, revision, refresh]);
  const current = status && status !== "failed" && status.revision === revision ? status.cast : cast;
  return <section>
    <header className="comic-cast-heading">
      <div>
        <h2>{t(isDrama ? "全剧角色" : "本集角色")}</h2>
        {isDrama && <small>{t("在此锁定整部戏的主要角色与默认造型，新建分集时将自动带入。")}</small>}
      </div>
      <div className="comic-actions">
        {!isDrama && onSyncDramaCast && dramaCastCount > 0 && (
          <button disabled={disabled} type="button" onClick={() => void onSyncDramaCast()}>
            {t("同步全剧角色（{0}）", [dramaCastCount])}
          </button>
        )}
        {onOpenLibrary && (
          <button type="button" onClick={() => onOpenLibrary()}>{t("管理角色库")}</button>
        )}
        <button disabled={disabled} type="button" onClick={() => setRefresh(value => value + 1)}>{t("检查更新")}</button>
        <button disabled={disabled} type="button" onClick={() => { setCreateError(""); setCreating(true); }}>＋ {t("新增角色")}</button>
        <button disabled={disabled} type="button" className="primary" onClick={() => setEdit("new")}>＋ {t("选择角色")}</button>
      </div>
    </header>
    {createError && <p className="comic-error" role="alert">{createError}</p>}
    {status === "failed" && <p className="comic-error" role="alert">{t("角色更新检查失败，请重试")}</p>}
    {status && status !== "failed" && status.revision !== revision && <p className="comic-error" role="status">
      {t(isDrama ? "其他窗口修改了整部剧，请刷新查看" : "其他窗口修改了本集，请刷新查看")}
    </p>}
    {current.length === 0 && <p className="comic-empty">{t(isDrama ? "尚未设定全剧角色" : "尚未为本集选角")}</p>}
    <div className="comic-cast-list">
      {current.map(entry => {
        const { snapshot, hasUpdates, archived, originDramaId, originDramaTitle } = entry;
        const isCrossDrama = Boolean(originDramaId && effectiveDramaId && originDramaId !== effectiveDramaId);
        return <article key={snapshot.characterId} className="comic-cast-card">
          <header>
            <div>
              <h3>{snapshot.name}</h3>
              <p>{t("已锁定造型")} · {snapshot.outfitName}</p>
              {originDramaTitle && (
                <small className="comic-drama-origin-tag" data-cross-drama={isCrossDrama ? "true" : undefined}>
                  {isCrossDrama ? t("跨剧 · 《{0}》", [originDramaTitle]) : t("归属 · 《{0}》", [originDramaTitle])}
                </small>
              )}
            </div>
            {archived ? <small>{t("已归档")}</small> : hasUpdates && <small className="comic-cast-update">{t("角色库有更新")}</small>}
          </header>
          <div className="comic-cast-assets">
            {snapshot.assets.map(asset => {
              const options = asset.kind === "slot" ? slots : expressions;
              const label = options.find(row => row.key === asset.key)?.labels[locale] ?? asset.key;
              return <figure key={asset.media.id}>
                <MediaPreview media={asset.media} title={label} />
                <figcaption>{label} · {t("版本 {0}", [asset.version])}</figcaption>
              </figure>;
            })}
          </div>
          {snapshot.assets.length === 0 && <p>{t("当前造型没有锁定图片")}</p>}
          {!disabled && <div className="comic-actions">
            {!archived && <>
              <button type="button" onClick={() => setEdit(entry)}>{t("更换造型")}</button>
              <button type="button" disabled={!hasUpdates} onClick={() => void change({ action: "sync", characterId: snapshot.characterId })}>
                {t("同步最新造型")}
              </button>
              {onOpenLibrary && (
                <button type="button" onClick={() => onOpenLibrary(snapshot.characterId)}>{t("管理形象")}</button>
              )}
            </>}
            <button type="button" onClick={() => {
              const confirmMsg = isDrama
                ? t("将此角色移出全剧角色表？已创建分集中的快照不受影响。")
                : t("移除角色，同时从本集分镜移除此角色？");
              if (window.confirm(confirmMsg)) void change({ action: "remove", characterId: snapshot.characterId });
            }}>{t(isDrama ? "移出本剧" : "移出本集")}</button>
          </div>}
        </article>;
      })}
    </div>
    {edit && <CastDialog edit={edit} currentDramaId={effectiveDramaId} cast={current} close={() => setEdit(null)} change={change} />}
    {creating && (
      <CharacterFormDialog
        defaultDramaId={effectiveDramaId ?? null}
        defaultDramaTitle={dramaTitle ?? null}
        quickCast={{
          label: t(isDrama ? "创建后直接加入当前剧目角色表" : "创建后直接加入本集角色表"),
          defaultChecked: true,
        }}
        close={() => setCreating(false)}
        save={async (input, opts) => {
          const { id } = await comicLibraryApi.createCharacter(input);
          const outfit = await comicLibraryApi.outfit(id, opts?.outfitName || t("默认造型"));
          if (opts?.addToCast) {
            const ok = await change({ action: "add", characterId: id, outfitId: outfit.id });
            if (!ok) setCreateError(t("角色已创建，但加入角色表失败，请点击选择角色手动添加"));
          }
          setRefresh(value => value + 1);
        }}
      />
    )}
  </section>;
}

function CastDialog({ edit, currentDramaId, cast, close, change }: {
  edit: ComicSeriesCast | "new";
  currentDramaId?: string;
  cast: ComicSeriesCast[];
  close: () => void;
  change: (action: ComicCastChange) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const dramas = useComicDramaOptions();
  const [characterId, setCharacterId] = useState(edit === "new" ? "" : edit.snapshot.characterId);
  const [outfitId, setOutfitId] = useState(edit === "new" ? "" : edit.snapshot.outfitId);
  const [dramaFilter, setDramaFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Awaited<ReturnType<typeof comicLibraryApi.characters>> | "error" | null>(null);
  const [character, setCharacter] = useState<ComicCharacterDetail | "error" | null>(null);
  const characterDetails = character && character !== "error" && character.id === characterId ? character : null;
  const excluded = new Set(cast.map(entry => entry.snapshot.characterId));
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
      setPage(1);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [searchInput]);
  useEffect(() => {
    if (edit !== "new") return;
    const controller = new AbortController();
    setList(null);
    void comicLibraryApi.characters({
      page: String(page),
      ...(searchQuery ? { query: searchQuery } : {}),
      ...(dramaFilter ? { dramaId: dramaFilter } : {}),
    }, controller.signal).then(value => {
      if (!controller.signal.aborted) setList(value);
    }).catch(() => { if (!controller.signal.aborted) setList("error"); });
    return () => controller.abort();
  }, [edit, page, searchQuery, dramaFilter]);
  useEffect(() => {
    if (!characterId) return;
    const controller = new AbortController();
    setCharacter(null);
    void comicLibraryApi.character(characterId, controller.signal).then(value => {
      if (!controller.signal.aborted) setCharacter(value);
    }).catch(() => { if (!controller.signal.aborted) setCharacter("error"); });
    return () => controller.abort();
  }, [characterId]);

  return <LibraryDialog title={t(edit === "new" ? "选择角色" : "更换造型")} submitLabel={t("锁定造型")} close={close}
    save={async () => {
      if (!characterDetails || !outfitId) throw new Error("Missing cast selection");
      const ok = await change({ action: edit === "new" ? "add" : "outfit", characterId, outfitId });
      if (!ok) throw new Error("Cast mutation failed");
    }}>
    {edit === "new" && <>
      <div className="comic-fields">
        <label>
          {t("按剧目筛选")}
          <select aria-label={t("按剧目筛选")} value={dramaFilter} onChange={event => {
            setDramaFilter(event.target.value); setCharacterId(""); setOutfitId(""); setPage(1);
          }}>
            <option value="">{t("全部剧目（含跨剧）")}</option>
            {currentDramaId && <option value={currentDramaId}>{t("仅本剧角色")}</option>}
            <option value="unassigned">{t("通用角色")}</option>
            {dramas.filter(item => item.id !== currentDramaId).map(item => (
              <option key={item.id} value={item.id}>{`《${item.title}》`}</option>
            ))}
          </select>
        </label>
        <label>
          {t("搜索角色")}
          <input
            aria-label={t("搜索角色")}
            value={searchInput}
            maxLength={120}
            placeholder={t("搜索名称、标签或归属剧目")}
            onChange={event => { setSearchInput(event.target.value); setCharacterId(""); setOutfitId(""); }}
          />
        </label>
      </div>
      <label>{t("角色名称")}<select aria-label={t("角色名称")} value={characterId} required onChange={event => {
        setCharacterId(event.target.value); setOutfitId("");
      }}>
        <option value="">{t("请选择")}</option>
        {list && list !== "error" && list.entries.filter(row => !excluded.has(row.id)).map(row => {
          const origin = row.dramaTitle
            ? (row.dramaId === currentDramaId ? t("本剧") : `《${row.dramaTitle}》`)
            : t("通用");
          return <option key={row.id} value={row.id}>{`${row.name} · ${origin}`}</option>;
        })}
      </select></label>
      {list && list !== "error" && <LibraryPagination page={page} more={list.more} change={next => {
        setCharacterId(""); setOutfitId(""); setPage(next);
      }} />}
    </>}
    <label>{t("造型套装")}<select aria-label={t("造型套装")} value={outfitId} required onChange={event => setOutfitId(event.target.value)}>
      <option value="">{t("请选择")}</option>
      {characterDetails?.outfits.map(outfit => <option value={outfit.id} key={outfit.id}>{outfit.name}</option>)}
    </select></label>
    {characterDetails && !characterDetails.outfits.length && <small>{t("请先在角色素材库建立造型套装")}</small>}
    {edit !== "new" && <small>{t("更换造型后，分镜中缺失的槽位会清空。")}</small>}
    {(list === "error" || character === "error") && <p className="comic-error" role="alert">{t("读取角色失败，请重试")}</p>}
  </LibraryDialog>;
}

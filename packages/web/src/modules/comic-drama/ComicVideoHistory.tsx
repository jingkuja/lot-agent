import { useEffect, useState } from "react";
import type { ComicCharacter, ComicEditListEntry, ComicVideoHistory as VideoHistory, ComicVideoTake } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { VideoTakeCard } from "./ComicVideoTakes.js";
import { comicEditApi, editError } from "./edit-api.js";
import { comicGenerationApi } from "./generation-api.js";
import { comicLibraryApi } from "./library-api.js";
import { LibraryDialog } from "./LibraryParts.js";

function filters(form: FormData) {
  const params = new URLSearchParams();
  const text = String(form.get("seriesQuery") ?? "").trim();
  const adopted = String(form.get("adopted") ?? "");
  const characterId = String(form.get("characterId") ?? "");
  const after = String(form.get("after") ?? "");
  const before = String(form.get("before") ?? "");
  if (text) params.set("seriesQuery", text);
  if (adopted) params.set("adopted", adopted);
  if (characterId) params.set("characterId", characterId);
  if (after) params.set("after", new Date(after + "T00:00:00").toISOString());
  if (before) {
    const end = new Date(before + "T00:00:00");
    end.setDate(end.getDate() + 1);
    params.set("before", end.toISOString());
  }
  return params.toString();
}

export function ComicVideoHistory({ open, choose, openEdit, picker = false }: {
  open: (seriesId: string, clipId: string) => void;
  choose: (id: string) => void;
  openEdit?: (editId: string) => void;
  picker?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grouped" | "timeline">("grouped");
  const [characters, setCharacters] = useState<ComicCharacter[]>([]);
  const [cursors, setCursors] = useState<string[]>([]);
  const [data, setData] = useState<VideoHistory | "error" | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [addingTake, setAddingTake] = useState<ComicVideoTake | null>(null);
  const cursor = cursors.at(-1);
  const reload = () => setRefresh(value => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    void comicLibraryApi.characters({ archived: "false", page: "1" }, controller.signal).then(res => {
      if (!controller.signal.aborted) setCharacters(res.entries);
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(query);
    if (cursor) params.set("cursor", cursor);
    setData(null);
    void comicGenerationApi.videoHistory(params, controller.signal).then(page => {
      if (!controller.signal.aborted) setData(page);
    }).catch(() => { if (!controller.signal.aborted) setData("error"); });
    return () => controller.abort();
  }, [cursor, query, refresh]);

  const grouped = (entries: ComicVideoTake[]) => {
    const map = new Map<string, { title: string; dramaTitle?: string; episodeNo?: number | null; takes: ComicVideoTake[] }>();
    for (const take of entries) {
      const bucket = map.get(take.seriesId) ?? {
        title: take.seriesTitle, dramaTitle: take.dramaTitle, episodeNo: take.episodeNo, takes: [],
      };
      bucket.takes.push(take);
      map.set(take.seriesId, bucket);
    }
    return [...map.entries()];
  };

  const renderCard = (take: ComicVideoTake) => (
    <VideoTakeCard
      key={take.id}
      take={take}
      open={() => open(take.seriesId, take.targetId)}
      choose={() => choose(take.id)}
      addToEdit={!picker && openEdit ? () => setAddingTake(take) : undefined}
      refresh={reload}
    />
  );

  return <>
    <header className="comic-heading">
      <h1>{t(picker ? "选择剪辑片源" : "历史成片")}</h1>
      <div className="comic-actions" role="group" aria-label={t("视图切换")}>
        <button type="button" aria-pressed={viewMode === "grouped"} onClick={() => setViewMode("grouped")}>{t("按剧集分组")}</button>
        <button type="button" aria-pressed={viewMode === "timeline"} onClick={() => setViewMode("timeline")}>{t("纯时间线")}</button>
      </div>
    </header>
    <form className="comic-history-controls" onSubmit={event => {
      event.preventDefault();
      setCursors([]);
      setQuery(filters(new FormData(event.currentTarget)));
      reload();
    }}>
      <label>{t("剧集名称")}<input name="seriesQuery" maxLength={120} /></label>
      <label>{t("出镜人物")}<select name="characterId">
        <option value="">{t("全部角色")}</option>
        {characters.map(c => <option key={c.id} value={c.id}>{c.dramaTitle ? `${c.name}（《${c.dramaTitle}》）` : c.name}</option>)}
      </select></label>
      <label>{t("采用状态")}<select name="adopted">
        <option value="">{t("全部")}</option><option value="true">{t("已采用")}</option><option value="false">{t("未采用")}</option>
      </select></label>
      <label>{t("完成起始日期")}<input name="after" type="date" /></label>
      <label>{t("完成结束日期")}<input name="before" type="date" /></label>
      <button type="submit">{t("筛选")}</button>
    </form>
    {data === "error" ? <button type="button" onClick={reload}>{t("重新读取")}</button> : data ? <>
      {!data.entries.length ? <p className="comic-empty">{t("暂无匹配的成片")}</p>
        : viewMode === "timeline" ? (
          <div className="comic-library-grid">{data.entries.map(renderCard)}</div>
        ) : (
          <div className="comic-video-groups">
            {grouped(data.entries).map(([seriesId, group]) => (
              <section key={seriesId} className="comic-edit-card">
                <header>
                  <div>
                    {group.dramaTitle && (
                      <small className="comic-take-origin">
                        {group.dramaTitle}{group.episodeNo ? ` · ${t("第 {0} 集", [group.episodeNo])}` : ""}
                      </small>
                    )}
                    <h2>{group.title}</h2>
                  </div>
                  <small>{t("{0} 条成片", [group.takes.length])}</small>
                </header>
                <div className="comic-library-grid">{group.takes.map(renderCard)}</div>
              </section>
            ))}
          </div>
        )}
      {(cursors.length > 0 || data.nextCursor) && <div className="comic-actions comic-library-pagination">
        <button type="button" disabled={!cursors.length} onClick={() => setCursors(values => values.slice(0, -1))}>{t("上一页")}</button>
        <button type="button" disabled={!data.nextCursor} onClick={() => {
          if (data.nextCursor) setCursors(values => [...values, data.nextCursor!]);
        }}>{t("下一页")}</button>
      </div>}
    </> : <p role="status">{t("加载中…")}</p>}
    {addingTake && openEdit && <AddToEditDialog take={addingTake} openEdit={openEdit} close={() => setAddingTake(null)} />}
  </>;
}

function AddToEditDialog({ take, openEdit, close }: {
  take: ComicVideoTake; openEdit: (id: string) => void; close: () => void;
}) {
  const { t } = useI18n();
  const [edits, setEdits] = useState<ComicEditListEntry[] | null>(null);
  const [lastEditId, setLastEditId] = useState<string | null>(null);
  const [target, setTarget] = useState<string>("__new__");
  useEffect(() => {
    const controller = new AbortController();
    void comicEditApi.list(undefined, controller.signal).then(res => {
      if (!controller.signal.aborted) {
        setEdits(res.entries);
        setLastEditId(res.lastEditId ?? null);
        if (res.lastEditId && res.entries.some(e => e.id === res.lastEditId)) setTarget(res.lastEditId);
        else if (res.entries[0]) setTarget(res.entries[0].id);
      }
    }).catch(() => { if (!controller.signal.aborted) setEdits([]); });
    return () => controller.abort();
  }, []);
  return (
    <LibraryDialog title={t("加入剪辑台")} submitLabel={t("确认加入")} close={close} describeError={editError} save={async (form, signal) => {
      if (target === "__new__") {
        const title = String(form.get("title") ?? "").trim() || take.seriesTitle;
        const created = await comicEditApi.create({ title, takeId: take.id }, signal);
        if (!signal.aborted) openEdit(created.id);
        return;
      }
      const chosen = edits?.find(e => e.id === target);
      if (!chosen) throw new Error("Missing edit");
      const updated = await comicEditApi.appendSource(chosen.id, { expectedRevision: chosen.revision, takeId: take.id }, signal);
      if (!signal.aborted) openEdit(updated.id);
    }}>
      <p>{take.seriesTitle} · {t("版本 {0}", [take.version])}</p>
      <label>{t("目标剪辑工程")}
        <select value={target} onChange={e => setTarget(e.target.value)}>
          <option value="__new__">{t("新建剪辑工程")}</option>
          {edits?.map(entry => (
            <option key={entry.id} value={entry.id}>
              {entry.title}{entry.id === lastEditId ? " · " + t("上次打开") : ""}
            </option>
          ))}
        </select>
      </label>
      {target === "__new__" && (
        <label>{t("工程名称")}<input name="title" required maxLength={120} defaultValue={take.seriesTitle} /></label>
      )}
    </LibraryDialog>
  );
}

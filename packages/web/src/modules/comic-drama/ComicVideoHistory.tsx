import { useEffect, useState } from "react";
import type { ComicVideoHistory as VideoHistory } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { VideoTakeCard } from "./ComicVideoTakes.js";
import { comicGenerationApi } from "./generation-api.js";

function filters(form: FormData) {
  const params = new URLSearchParams();
  const text = String(form.get("seriesQuery") ?? "").trim();
  const adopted = String(form.get("adopted") ?? "");
  const after = String(form.get("after") ?? "");
  const before = String(form.get("before") ?? "");
  if (text) params.set("seriesQuery", text);
  if (adopted) params.set("adopted", adopted);
  if (after) params.set("after", new Date(after + "T00:00:00").toISOString());
  if (before) {
    const end = new Date(before + "T00:00:00");
    end.setDate(end.getDate() + 1);
    params.set("before", end.toISOString());
  }
  return params.toString();
}

export function ComicVideoHistory({ open }: { open: (seriesId: string, clipId: string) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [data, setData] = useState<VideoHistory | "error" | null>(null);
  const [refresh, setRefresh] = useState(0);
  const cursor = cursors.at(-1);
  const reload = () => setRefresh(value => value + 1);
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

  return <>
    <header className="comic-heading"><h1>{t("历史成片")}</h1></header>
    <form className="comic-history-controls" onSubmit={event => {
      event.preventDefault();
      setCursors([]);
      setQuery(filters(new FormData(event.currentTarget)));
      reload();
    }}>
      <label>{t("剧集名称")}<input name="seriesQuery" maxLength={120} /></label>
      <label>{t("采用状态")}<select name="adopted">
        <option value="">{t("全部")}</option><option value="true">{t("已采用")}</option><option value="false">{t("未采用")}</option>
      </select></label>
      <label>{t("完成起始日期")}<input name="after" type="date" /></label>
      <label>{t("完成结束日期")}<input name="before" type="date" /></label>
      <button type="submit">{t("筛选")}</button>
    </form>
    {data === "error" ? <button type="button" onClick={reload}>{t("重新读取")}</button> : data ? <>
      <div className="comic-library-grid">{data.entries.map(take =>
        <VideoTakeCard key={take.id} take={take} open={() => open(take.seriesId, take.targetId)} refresh={reload} />)}</div>
      {!data.entries.length && <p className="comic-empty">{t("暂无匹配的成片")}</p>}
      {(cursors.length > 0 || data.nextCursor) && <div className="comic-actions comic-library-pagination">
        <button type="button" disabled={!cursors.length} onClick={() => setCursors(values => values.slice(0, -1))}>{t("上一页")}</button>
        <button type="button" disabled={!data.nextCursor} onClick={() => {
          if (data.nextCursor) setCursors(values => [...values, data.nextCursor!]);
        }}>{t("下一页")}</button>
      </div>}
    </> : <p role="status">{t("加载中…")}</p>}
  </>;
}

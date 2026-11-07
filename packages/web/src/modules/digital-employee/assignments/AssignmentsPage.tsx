import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelCatalog } from "../../../hooks/useModels.js";
import { useI18n } from "../../../i18n/index.js";
import { employeeApi } from "../api.js";
import type { Assignment, AssignmentFilter, AssignmentStatusFilter } from "../types.js";
import { AssignmentCard } from "./AssignmentCard.js";
import { AssignmentComposer } from "./AssignmentComposer.js";
import { dayLabel, groupByDay, isOpen, quickRange, startOfDay, toLocalInput, type QuickRange } from "./grouping.js";
import { usePolling } from "../usePolling.js";
import { useEmployeeLabels } from "../employee-labels.js";

const POLL_MS = 5_000;
const QUICK: Array<{ range: QuickRange; label: string }> = [
  { range: "today", label: "今天" }, { range: "yesterday", label: "昨天" }, { range: "week", label: "最近 7 天" }, { range: "month", label: "最近 30 天" },
];
const STATUS: Array<{ value: AssignmentStatusFilter | ""; label: string }> = [
  { value: "", label: "全部状态" }, { value: "active", label: "进行中" }, { value: "paused", label: "已暂停" },
  { value: "succeeded", label: "已完成" }, { value: "failed", label: "没有完成" }, { value: "cancelled", label: "已取消" },
];

interface Search {
  q: string;
  status: AssignmentStatusFilter | "";
  from: string;
  to: string;
}

const NO_SEARCH: Search = { q: "", status: "", from: "", to: "" };

function toFilter(search: Search): AssignmentFilter {
  return {
    q: search.q.trim() || undefined,
    status: search.status || undefined,
    from: search.from ? new Date(search.from).toISOString() : undefined,
    to: search.to ? new Date(search.to).toISOString() : undefined,
  };
}

/** Cards by day. Anything still open from an earlier day comes up top, so a paused task cannot sink out of sight. */
export function AssignmentsPage({ employeeName, modelCatalog, onOpen }: { employeeName: string; modelCatalog: ModelCatalog; onOpen: (id: string) => void }) {
  const { t, locale } = useI18n();
  const labels = useEmployeeLabels(employeeName);
  const [form, setForm] = useState<Search>(NO_SEARCH);
  const [search, setSearch] = useState<Search>(NO_SEARCH);
  const [items, setItems] = useState<Assignment[]>([]);
  const [pinned, setPinned] = useState<Assignment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const searching = search !== NO_SEARCH;

  const query = useCallback((extra: AssignmentFilter = {}) => employeeApi.listAssignments({
    ...toFilter(search), ...(searching ? {} : { openBefore: startOfDay(new Date()).toISOString() }), ...extra,
  }), [search, searching]);

  /** Refreshes the newest page into what is on screen, so older days already loaded stay put while tasks update. */
  const load = useCallback(async () => {
    try {
      const page = await query();
      const fresh = new Set(page.items.map((item) => item.id));
      const oldest = page.items.at(-1)?.createdAt;
      setItems((current) => {
        const older = page.nextCursor && oldest ? current.filter((item) => !fresh.has(item.id) && item.createdAt < oldest) : [];
        if (!older.length) setCursor(page.nextCursor);
        return [...page.items, ...older];
      });
      setPinned(page.pinned);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取失败");
    } finally {
      setLoaded(true);
    }
  }, [query]);

  useEffect(() => {
    setLoaded(false); setItems([]); setPinned([]); setCursor(null);
    void load();
  }, [load]);

  const hasOpen = useMemo(() => [...items, ...pinned].some(isOpen), [items, pinned]);
  usePolling(load, POLL_MS, hasOpen);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await query({ cursor });
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setCursor(page.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取失败");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, query]);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !cursor || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) void loadMore(); });
    observer.observe(target);
    return () => observer.disconnect();
  }, [cursor, loadMore]);

  const act = async (id: string, action: "resume" | "retry" | "cancel") => {
    setBusyId(id); setError(null);
    try {
      if (action === "resume") await employeeApi.resumeAssignment(id);
      else if (action === "retry") await employeeApi.retryAssignment(id);
      else await employeeApi.cancelAssignment(id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  const apply = (next: Search) => {
    setForm(next);
    setSearch(next.q.trim() || next.status || next.from || next.to ? next : NO_SEARCH);
  };
  const applyQuick = (range: QuickRange) => {
    const { from, to } = quickRange(range, new Date());
    apply({ ...form, from: toLocalInput(from), to: toLocalInput(to) });
  };

  const now = new Date();
  const card = (item: Assignment, showDate: boolean) => <AssignmentCard
    key={item.id} item={item} showDate={showDate} busy={busyId === item.id} onOpen={() => onOpen(item.id)} onAction={(action) => void act(item.id, action)}
  />;

  return <div className="de-page de-assignments-page">
    <header className="de-employee-page-head"><h1>{labels.assignments}</h1></header>
    <AssignmentComposer modelCatalog={modelCatalog} onCreated={() => { apply(NO_SEARCH); void load(); }} />

    <button type="button" className="de-secondary-button de-assignment-filter-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
      {t(searching ? "筛选中" : "筛选")}
    </button>
    <form
      className={filtersOpen ? "de-assignment-filters is-open" : "de-assignment-filters"}
      aria-label={t("搜索任务")}
      onSubmit={(event) => { event.preventDefault(); apply(form); }}
    >
      <input aria-label={t("关键词")} type="search" placeholder={t("搜索任务和子任务")} value={form.q} onChange={(event) => setForm({ ...form, q: event.target.value })} />
      <select aria-label={t("状态")} value={form.status} onChange={(event) => apply({ ...form, status: event.target.value as Search["status"] })}>
        {STATUS.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
      </select>
      <label><span>{t("从")}</span><input type="datetime-local" value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value })} /></label>
      <label><span>{t("到")}</span><input type="datetime-local" value={form.to} onChange={(event) => setForm({ ...form, to: event.target.value })} /></label>
      <div className="de-assignment-quick">
        {QUICK.map((option) => <button type="button" key={option.range} className="de-text-button" onClick={() => applyQuick(option.range)}>{t(option.label)}</button>)}
      </div>
      <div className="de-assignment-filter-actions">
        <button type="submit" className="de-primary-button">{t("搜索")}</button>
        {searching && <button type="button" className="de-secondary-button" onClick={() => apply(NO_SEARCH)}>{t("清除")}</button>}
      </div>
    </form>

    {error && <div className="de-inline-error" role="alert"><span>{t(error)}</span><button onClick={() => setError(null)}>{t("关闭")}</button></div>}
    {!loaded && !error && <div className="de-state">{t("加载中…")}</div>}
    {loaded && !items.length && !pinned.length && <div className="de-state de-empty-state">
      <strong>{t(searching ? "没有符合条件的任务" : "还没有任务")}</strong>
      {!searching && <p>{t("交代一件事，员工在后台做完后告诉你。")}</p>}
    </div>}

    {pinned.length > 0 && <section className="de-assignment-day">
      <h2>{t("还没结束")}</h2>
      <div className="de-assignment-list">{pinned.map((item) => card(item, true))}</div>
    </section>}
    {groupByDay(items).map(({ day, items: dayItems }) => {
      const label = dayLabel(day, now, locale);
      return <section className="de-assignment-day" key={day}>
        <h2>{label.relative ? t(label.relative) : label.date}{label.relative && <small>{label.date}</small>}</h2>
        <div className="de-assignment-list">{dayItems.map((item) => card(item, false))}</div>
      </section>;
    })}
    {cursor && <div ref={sentinel} className="de-assignment-more">
      <button type="button" className="de-secondary-button" disabled={loadingMore} onClick={() => void loadMore()}>{t(loadingMore ? "加载中…" : "加载更早的任务")}</button>
    </div>}
  </div>;
}

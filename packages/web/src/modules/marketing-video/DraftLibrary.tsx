import { useEffect, useRef, useState } from "react";
import type { MarketingProject } from "@lot-agent/core/marketing-video";
import { request } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { normalizeProject, type Project } from "./api.js";
import type { DraftSession } from "./session.js";

const statusLabels: Record<string, string> = { draft: "草稿", pending: "等待生成", running: "生成中", succeeded: "已生成", failed: "生成未完成", cancelled: "已取消" };

/** Space held by the owner's drafts (`GET /marketing-videos/usage`). */
export interface DraftUsage { videoBytes: number; materialBytes: number; analysisBytes: number; analysisLimitBytes: number }

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Saved drafts: search, open, delete and load the next page. */
export function DraftLibrary({ projects, nextCursor, query, currentId, usage, openBusy, moreBusy, deleteBusy, onQuery, onOpen, onDelete, onMore, onShow }: {
  projects: MarketingProject[]; nextCursor?: string; query: string; currentId?: string; usage?: DraftUsage;
  openBusy: boolean; moreBusy: boolean; deleteBusy: boolean;
  onQuery(query: string): void; onOpen(project: MarketingProject): void; onDelete(project: MarketingProject): void; onMore(): void; onShow(): void;
}) {
  const { t } = useI18n();
  return <details className="mv-library" onToggle={e => { if (e.currentTarget.open) onShow(); }}><summary>{t("我的视频草稿")} · {projects.length}{nextCursor ? "+" : ""}</summary>
    {usage && <p className="mv-hint mv-usage">{t("已用空间 {0}：成片与片段 {1} · 使用的素材 {2} · 参考分析 {3} / {4}", [
      formatBytes(usage.videoBytes + usage.materialBytes + usage.analysisBytes), formatBytes(usage.videoBytes), formatBytes(usage.materialBytes),
      formatBytes(usage.analysisBytes), formatBytes(usage.analysisLimitBytes)])}</p>}
    <input className="mv-draft-search" type="search" value={query} maxLength={100} placeholder={t("搜索标题、主题或文案")} aria-label={t("搜索草稿")} onChange={e => onQuery(e.target.value)} />
    {!projects.length && !!query.trim() && <p className="mv-hint">{t("没有找到匹配的草稿")}</p>}
    <div className="mv-draft-list">{projects.map(p => {
      const generating = ["pending", "running"].includes(p.status);
      return <div key={p.id} className="mv-draft-item">
        <button disabled={openBusy} aria-pressed={p.id === currentId} onClick={() => onOpen(p)}>
          <strong>{p.draft.publishTitle || p.draft.topic || t("未命名草稿")}</strong>
          <span>{p.draft.durationSec}s · {t(statusLabels[p.status] ?? p.status)}</span>
        </button>
        <button className="mv-draft-delete" disabled={deleteBusy || generating} aria-label={t("删除草稿")} title={t(generating ? "视频正在生成，请先取消，任务结束后再删除。" : "删除草稿")} onClick={() => onDelete(p)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
        </button>
      </div>;
    })}</div>
    {nextCursor && <button className="mv-draft-more" disabled={moreBusy} onClick={onMore}>{t("加载更多草稿")}</button>}
  </details>;
}

/** Saved drafts list: first page on load, a debounced search, and further pages. */
export function useDraftLibrary(session: DraftSession, ready: boolean, onError: (error: unknown) => void) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [query, setQuery] = useState("");
  const [usage, setUsage] = useState<DraftUsage>();
  // Only the latest search applies; an older response never replaces it.
  const latest = useRef(0);
  const loadedQuery = useRef("");
  async function load(search: string, cursor?: string) {
    const token = ++latest.current;
    const params = new URLSearchParams({ limit: "20" });
    if (search.trim()) params.set("q", search.trim());
    if (cursor) params.set("cursor", cursor);
    const list = await request<{ data: Project[]; nextCursor?: string }>(`/marketing-videos?${params}`);
    if (!session.alive || token !== latest.current) return;
    const page = list.data.map(normalizeProject);
    setProjects(old => cursor ? [...old, ...page.filter(p => !old.some(item => item.id === p.id))] : page);
    setNextCursor(list.nextCursor);
  }
  useEffect(() => {
    if (!ready || query === loadedQuery.current) return;
    const timer = setTimeout(() => {
      loadedQuery.current = query;
      void load(query).catch(e => { if (session.alive) onError(e); });
    }, 300);
    return () => clearTimeout(timer);
  }, [query, ready]);
  return {
    projects, nextCursor, query, setQuery,
    /** Show the first page loaded with the studio. */
    showFirstPage(list: { data: Project[]; nextCursor?: string }) { setProjects(list.data.map(normalizeProject)); setNextCursor(list.nextCursor); },
    /** Move a saved or polled project to the top. */
    put(p: Project) { setProjects(old => [p, ...old.filter(item => item.id !== p.id)]); },
    remove(id: string) { setProjects(old => old.filter(item => item.id !== id)); },
    usage,
    /** Usage is informational: a failed read leaves the line hidden or stale. */
    refreshUsage() {
      void request<DraftUsage>("/marketing-videos/usage").then(value => { if (session.alive) setUsage(value); }, () => {});
    },
    loadMore: () => load(query, nextCursor),
  };
}

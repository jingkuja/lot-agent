import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../../api/client.js";
import { ProfileEditor } from "../components/ProfileEditor.js";
import {
  HEALTH_LABELS,
  RELATIONSHIP_LABELS,
  type CustomerProfile,
  type Health,
  type ProfileInput,
  type RelationshipStage,
} from "../types.js";

interface ProfileListPageProps {
  onOpenProfile: (profileId: string) => void;
}

const RELATIONSHIP_OPTIONS = Object.entries(RELATIONSHIP_LABELS) as Array<[RelationshipStage, string]>;
const HEALTH_OPTIONS = Object.entries(HEALTH_LABELS) as Array<[Health, string]>;

function time(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function ProfileListPage({ onOpenProfile }: ProfileListPageProps) {
  const [items, setItems] = useState<CustomerProfile[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [relationshipStage, setRelationshipStage] = useState<RelationshipStage | "">("");
  const [health, setHealth] = useState<Health | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listCustomerProfiles({ page, limit, q: query, relationshipStage, health });
      setItems(result.items);
      setTotal(result.total);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "客户画像加载失败");
    } finally {
      setLoading(false);
    }
  }, [page, query, relationshipStage, health]);

  useEffect(() => { void load(); }, [load]);

  const pages = Math.max(1, Math.ceil(total / limit));
  const range = useMemo(() => `${total ? (page - 1) * limit + 1 : 0}–${Math.min(page * limit, total)} / ${total}`, [page, total]);

  const search = (event: React.FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryDraft.trim());
  };

  const create = async (input: ProfileInput) => {
    setSaving(true);
    try {
      const created = await api.createCustomerProfile(input);
      setNewOpen(false);
      onOpenProfile(created.profile.id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="de-page de-profile-list-page">
      <header className="de-page-header">
        <div>
          <p className="de-eyebrow">数字员工 / 客户画像</p>
          <h1>客户画像管理</h1>
          <p>把身份主档、原始观察和当前产品状态分开保存，方便持续跟进且可追溯。</p>
        </div>
        <button className="de-primary-button" onClick={() => setNewOpen(true)}>＋ 新建画像</button>
      </header>

      <section className="de-filter-card" aria-label="客户画像筛选">
        <form className="de-search" onSubmit={search}>
          <input value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="搜索名称或别名" maxLength={200} />
          <button className="de-secondary-button" type="submit">搜索</button>
        </form>
        <label className="de-filter-select"><span>总体关系</span>
          <select value={relationshipStage} onChange={(event) => { setRelationshipStage(event.target.value as RelationshipStage | ""); setPage(1); }}>
            <option value="">全部</option>
            {RELATIONSHIP_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="de-filter-select"><span>健康度</span>
          <select value={health} onChange={(event) => { setHealth(event.target.value as Health | ""); setPage(1); }}>
            <option value="">全部</option>
            {HEALTH_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <button className="de-quiet-button" type="button" onClick={() => { setQueryDraft(""); setQuery(""); setRelationshipStage(""); setHealth(""); setPage(1); }}>清除筛选</button>
      </section>

      {error && <div className="de-inline-error" role="alert"><span>{error}</span><button onClick={() => void load()}>重试</button></div>}

      <section className="de-table-card">
        <div className="de-table-meta"><span>{loading ? "正在加载…" : `共 ${total} 位客户`}</span><span>{!loading && range}</span></div>
        {loading ? (
          <div className="de-state">正在读取客户画像…</div>
        ) : items.length === 0 ? (
          <div className="de-state de-empty-state">
            <span className="de-empty-icon" aria-hidden>◌</span>
            <strong>{query || relationshipStage || health ? "没有匹配的客户画像" : "还没有客户画像"}</strong>
            <p>{query || relationshipStage || health ? "调整筛选条件后再试。" : "可手工新建，也可在 AI 工作台里用自然语言记录客户情况。"}</p>
            {!query && !relationshipStage && !health && <button className="de-primary-button" onClick={() => setNewOpen(true)}>新建第一条画像</button>}
          </div>
        ) : (
          <div className="de-profile-table-wrap">
            <table className="de-profile-table">
              <thead><tr><th>客户</th><th>总体关系</th><th>健康度</th><th>标签</th><th>最近观察</th><th aria-label="操作" /></tr></thead>
              <tbody>{items.map((profile) => (
                <tr key={profile.id}>
                  <td>
                    <button className="de-profile-name" onClick={() => onOpenProfile(profile.id)}>
                      <strong>{profile.displayName}</strong>
                      <span>{profile.customerRegion || profile.aliases.slice(0, 2).join("、") || "未补充客户区域"}</span>
                    </button>
                  </td>
                  <td><span className={`de-status-chip stage-${profile.relationshipStage}`}>{RELATIONSHIP_LABELS[profile.relationshipStage]}</span></td>
                  <td><span className={`de-status-chip health-${profile.overallHealth}`}>{HEALTH_LABELS[profile.overallHealth]}</span></td>
                  <td><div className="de-tag-list">{profile.tags.length ? profile.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>) : <em>—</em>}</div></td>
                  <td><span className="de-time">{time(profile.lastObservedAt)}</span></td>
                  <td><button className="de-row-action" onClick={() => onOpenProfile(profile.id)}>查看</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {!loading && total > limit && <footer className="de-pagination"><button className="de-secondary-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span>第 {page} / {pages} 页</span><button className="de-secondary-button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</button></footer>}
      </section>

      {newOpen && <ProfileEditor saving={saving} onClose={() => !saving && setNewOpen(false)} onSave={create} />}
    </div>
  );
}

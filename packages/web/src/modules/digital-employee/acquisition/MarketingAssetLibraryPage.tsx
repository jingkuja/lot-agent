import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import type { MarketingAsset, MarketingAssetType } from "../types.js";
import { MarketingAssetCard } from "./MarketingAssetCard.js";
import { DeploymentManager } from "./DeploymentManager.js";

export function MarketingAssetLibraryPage({ onReuse, onCreate }: { onReuse: (asset: MarketingAsset) => void; onCreate: () => void }) {
  const [items, setItems] = useState<MarketingAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [range, setRange] = useState("3d");
  const [assetType, setAssetType] = useState<MarketingAssetType | "">("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState<MarketingAsset | null>(null);
  const limit = 12;

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const result = await api.listMarketingAssets({ range, assetType, page, limit });
      setItems(result.items); setTotal(result.total);
      setManaging((current) => current ? result.items.find((item) => item.id === current.id) ?? current : null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "营销资产加载失败"); }
    finally { if (!quiet) setLoading(false); }
  }, [range, assetType, page]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!items.some((item) => item.generationStatus === "pending" || item.generationStatus === "running")) return;
    const timer = window.setInterval(() => void load(true), 2_000);
    return () => window.clearInterval(timer);
  }, [items, load]);

  const archive = async (item: MarketingAsset) => {
    if (!window.confirm(`归档“${item.title}”？投放记录会保留。`)) return;
    if (item.taskId && (item.generationStatus === "pending" || item.generationStatus === "running")) {
      await api.cancelTask(item.taskId).catch(() => ({ ok: false }));
    }
    await api.archiveMarketingAsset(item.id); void load();
  };
  const pages = Math.max(1, Math.ceil(total / limit));

  return <section className="de-acquisition-workspace" aria-label="营销资产库">
    <header className="de-acquisition-section-head"><div><p>营销资产库</p><h2>已生成内容与投放状态</h2><span>生成、投放和产生效果是三个独立状态。</span></div><button className="de-primary-button" onClick={onCreate}>＋ 创作新内容</button></header>
    <div className="de-acquisition-toolbar">
      <label><span>时间</span><select value={range} onChange={(event) => { setRange(event.target.value); setPage(1); }}><option value="3d">最近 3 天</option><option value="7d">最近一周</option><option value="30d">最近一月</option><option value="all">所有</option></select></label>
      <label><span>类型</span><select value={assetType} onChange={(event) => { setAssetType(event.target.value as MarketingAssetType | ""); setPage(1); }}><option value="">全部内容</option><option value="text">文案</option><option value="poster">海报</option><option value="video">视频</option></select></label>
      <span className="de-acquisition-total">共 {total} 项</span>
    </div>
    {error && <div className="de-inline-error"><span>{error}</span><button onClick={() => void load()}>重试</button></div>}
    {loading ? <div className="de-state">正在读取营销资产…</div> : items.length === 0 ? <div className="de-state de-empty-state"><span className="de-empty-icon">▧</span><strong>这个范围内还没有营销资产</strong><p>从每日推荐或创作工作台生成的内容会自动出现在这里。</p><button className="de-primary-button" onClick={onCreate}>开始创作</button></div> :
      <div className="de-asset-grid">{items.map((item) => <MarketingAssetCard key={item.id} item={item} onManage={() => setManaging(item)} onReuse={() => onReuse(item)} onArchive={() => void archive(item)} />)}</div>}
    {total > limit && <footer className="de-pagination"><button className="de-secondary-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span>第 {page} / {pages} 页</span><button className="de-secondary-button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</button></footer>}
    {managing && <DeploymentManager asset={managing} onClose={() => setManaging(null)} onChanged={() => void load(true)} />}
  </section>;
}

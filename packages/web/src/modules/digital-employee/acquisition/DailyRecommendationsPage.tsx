import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import type { CampaignRecommendation } from "../types.js";
import { RecommendationCard } from "./RecommendationCard.js";

export function DailyRecommendationsPage({ onCreate }: { onCreate: (item: CampaignRecommendation) => void }) {
  const [items, setItems] = useState<CampaignRecommendation[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { setLoading(true); try { let result = await api.listAcquisitionRecommendations("pending"); if (!result.generatedAt) { setRefreshing(true); result = await api.refreshAcquisitionRecommendations(); setRefreshing(false); } setItems(result.items); setGeneratedAt(result.generatedAt); } catch (reason) { setError(reason instanceof Error ? reason.message : "推荐加载失败"); } finally { setRefreshing(false); setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const refresh = async () => { setRefreshing(true); setError(null); try { const result = await api.refreshAcquisitionRecommendations(); setItems(result.items); setGeneratedAt(result.generatedAt); } catch (reason) { setError(reason instanceof Error ? reason.message : "今日推荐生成失败"); } finally { setRefreshing(false); } };
  const ignore = async (item: CampaignRecommendation) => { await api.updateAcquisitionRecommendation(item.id, "ignored"); setItems((current) => current.filter((entry) => entry.id !== item.id)); };
  return <section className="de-acquisition-workspace">
    <header className="de-acquisition-section-head"><div><p>每日推荐</p><h2>今天值得尝试的客群营销方向</h2><span>{generatedAt ? `上次生成 ${time(generatedAt)} · 推荐 7 天后过期` : "基于客群聚合画像与已确认营销资料生成"}</span></div><button className="de-primary-button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "AI 正在分析…" : "↻ 重新生成今日推荐"}</button></header>
    {error && <div className="de-inline-error"><span>{error}</span><button onClick={() => void refresh()}>重试</button></div>}
    {loading ? <div className="de-state">正在读取今日推荐…</div> : items.length === 0 ? <div className="de-state de-empty-state"><span className="de-empty-icon">✦</span><strong>今天还没有营销推荐</strong><p>系统会读取脱敏群像与有效产品资料，不会把单个客户观点直接当成群体规律。</p><button className="de-primary-button" onClick={() => void refresh()}>生成今日推荐</button></div> : <div className="de-recommendation-groups">{(["copy", "poster", "video_script"] as const).map((type) => { const group = items.filter((item) => item.type === type); return group.length ? <section key={type}><h3>{type === "copy" ? "营销文案方向" : type === "poster" ? "海报创意方向" : "视频脚本方向"}<span>{group.length}</span></h3><div className="de-recommendation-grid">{group.map((item) => <RecommendationCard key={item.id} item={item} onCreate={() => onCreate(item)} onIgnore={() => void ignore(item)} />)}</div></section> : null; })}</div>}
  </section>;
}

function time(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }

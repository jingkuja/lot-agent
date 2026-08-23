import { useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import type { MarketingBrandAssets, MarketingProduct } from "../types.js";

export function MarketingMaterialsHome({ onOpenManagement, onPrompt }: { onOpenManagement: () => void; onPrompt: (prompt: string) => void }) {
  const [products, setProducts] = useState<MarketingProduct[]>([]);
  const [brand, setBrand] = useState<MarketingBrandAssets | null>(null);
  const [error, setError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void Promise.all([api.listMarketingProducts({ limit: 5 }), api.getMarketingBrandAssets()]).then(([result, brandResult]) => {
      if (active) { setProducts(result.items); setBrand(brandResult); }
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [reloadNonce]);
  return <section className="de-home marketing-home" aria-label="营销资料工作台">
    <header className="de-home-header"><div className="de-home-heading"><span className="de-home-mark" aria-hidden>◆</span><div><p className="de-home-eyebrow">营销资料工作台</p><h1>让单客跟进与客群营销都有依据</h1><p>统一管理产品卖点、可信事实、权益期限、案例素材与品牌口径，供商机雷达和获客宝共同引用。</p></div></div><button className="de-primary-button" onClick={onOpenManagement}>管理资料</button></header>
    <div className="de-home-grid"><article className="de-cohort-card"><div className="de-home-card-heading"><div><p className="de-home-card-kicker">产品事实库</p><h2>{error ? "读取失败" : products.length ? `${products.length} 个最近产品` : "等待录入产品"}</h2></div></div>{error ? <div className="de-home-inline-state"><p>营销资料暂时无法读取，你仍可直接对话。</p><button type="button" onClick={() => setReloadNonce((nonce) => nonce + 1)}>重试</button></div> : <div className="marketing-home-products">{products.length ? products.map((product) => <button key={product.id} onClick={onOpenManagement}><strong>{product.name}</strong><span>{product.positioning || "待补充定位"}</span><small>{product.verifiableFacts.length} 条事实 · {product.currentBenefits.length} 项权益</small></button>) : <button onClick={onOpenManagement}><strong>建立第一条产品资料</strong><span>先把产品能说什么定义清楚</span></button>}</div>}</article>
    <article className="de-recent-card"><div className="de-home-card-heading"><div><p className="de-home-card-kicker">品牌约束</p><h2>统一表达</h2></div></div>{error ? <div className="de-home-inline-state"><p>品牌约束暂时无法读取。</p></div> : <><Fact title="语气" values={brand?.tone ?? []} /><Fact title="行动号召" values={brand?.standardCallsToAction ?? []} /><Fact title="视觉资产" values={brand?.visualAssets.map((asset) => asset.name) ?? []} /></>}</article></div>
    <div className="de-quick-prompts"><span>快捷开始</span><button onClick={() => onPrompt("我要新建一条产品营销资料，请引导我补充产品定位、核心价值和可验证事实。")}>新建产品资料<span>↗</span></button><button onClick={() => onPrompt("请查询当前即将到期或已经过期的产品权益。")}>检查权益期限<span>↗</span></button><button onClick={() => onPrompt("请查询品牌语气、标准行动号召和禁用表达，概括当前营销内容约束。")}>查看品牌约束<span>↗</span></button></div>
  </section>;
}

function Fact({ title, values }: { title: string; values: string[] }) {
  return <div className="marketing-home-fact"><span>{title}</span>{values.length ? <div className="de-tag-list">{values.slice(0, 4).map((value) => <span key={value}>{value}</span>)}</div> : <p>尚未设置</p>}</div>;
}

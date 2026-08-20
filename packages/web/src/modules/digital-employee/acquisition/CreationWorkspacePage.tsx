import { useEffect, useMemo, useState } from "react";
import { api } from "../../../api/client.js";
import type { MarketingProduct } from "../types.js";
import type { AcquisitionModelConfiguration, CustomerSegment, MarketingAsset } from "../types.js";
import { ModelConfigurationGuard } from "./ModelConfigurationGuard.js";

export interface CreationSeed {
  nonce?: number;
  recommendationId?: string;
  parentAssetId?: string;
  segmentId?: string;
  publicAudience?: string;
  productId?: string;
  title?: string;
  prompt?: string;
  channels?: string[];
  assetType?: "copy" | "poster" | "video";
  durationSeconds?: 15 | 30 | 60;
}

const CHANNELS = ["朋友圈", "公众号", "私域群", "视频号", "抖音/快手", "小红书", "活动页"];

export function CreationWorkspacePage({ seed, onOpenAssets, onOpenSegments }: { seed?: CreationSeed; onOpenAssets: () => void; onOpenSegments: () => void }) {
  const [segments, setSegments] = useState<CustomerSegment[]>([]);
  const [products, setProducts] = useState<MarketingProduct[]>([]);
  const [configuration, setConfiguration] = useState<AcquisitionModelConfiguration | null>(null);
  const [contextLoading, setContextLoading] = useState(true);
  const [assetType, setAssetType] = useState<"copy" | "poster" | "video">("copy");
  const [segmentId, setSegmentId] = useState("");
  const [publicAudience, setPublicAudience] = useState("");
  const [productId, setProductId] = useState("");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("获得更多咨询和有效线索");
  const [channels, setChannels] = useState<string[]>(["朋友圈"]);
  const [callToAction, setCallToAction] = useState("了解详情或预约咨询");
  const [prompt, setPrompt] = useState("");
  const [durationSeconds, setDurationSeconds] = useState<15 | 30 | 60>(15);
  const [recommendationId, setRecommendationId] = useState<string | undefined>();
  const [parentAssetId, setParentAssetId] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MarketingAsset | null>(null);

  useEffect(() => {
    let active = true;
    setContextLoading(true);
    void Promise.all([api.listCustomerSegments(), api.listMarketingProducts({ status: "active", page: 1, limit: 100 }), api.getAcquisitionModelConfiguration()])
      .then(([segmentResult, productResult, modelResult]) => { if (!active) return; setSegments(segmentResult.items); setProducts(productResult.items); setConfiguration(modelResult); setSegmentId((current) => current || segmentResult.items[0]?.id || ""); setProductId((current) => current || productResult.items[0]?.id || ""); })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : "创作上下文加载失败"))
      .finally(() => active && setContextLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!seed) return;
    if (seed.assetType) setAssetType(seed.assetType);
    if (seed.segmentId !== undefined) { setSegmentId(seed.segmentId); setPublicAudience(""); }
    if (seed.publicAudience !== undefined) { setPublicAudience(seed.publicAudience); if (!seed.segmentId) setSegmentId(""); }
    if (seed.productId) setProductId(seed.productId);
    if (seed.title !== undefined) setTitle(seed.title);
    if (seed.prompt !== undefined) setPrompt(seed.prompt);
    if (seed.channels?.length) setChannels(seed.channels);
    if (seed.durationSeconds) setDurationSeconds(seed.durationSeconds);
    setRecommendationId(seed.recommendationId);
    setParentAssetId(seed.parentAssetId);
    setResult(null);
  }, [seed?.nonce]);

  useEffect(() => {
    if (!result || !["pending", "running"].includes(result.generationStatus)) return;
    const timer = window.setInterval(() => void api.getMarketingAsset(result.id).then((next) => setResult(next)), 2_000);
    return () => window.clearInterval(timer);
  }, [result?.id, result?.generationStatus]);

  const selectedSegment = segments.find((item) => item.id === segmentId);
  const selectedProduct = products.find((item) => item.id === productId);
  const mediaBlocked = assetType === "poster" ? !configuration?.image : assetType === "video" ? !configuration?.video : false;
  const canSubmit = prompt.trim().length >= 2 && productId && (segmentId || publicAudience.trim()) && channels.length && callToAction.trim() && !mediaBlocked && !creating;

  const submit = async () => {
    if (!canSubmit) return;
    setCreating(true); setError(null); setResult(null);
    try {
      const created = await api.createMarketingAsset({ assetType, prompt: prompt.trim(), segmentId: segmentId || undefined, publicAudience: segmentId ? undefined : publicAudience.trim(), productId, recommendationId, parentAssetId, objective, channels, callToAction, title: title.trim() || undefined, durationSeconds: assetType === "video" ? durationSeconds : undefined });
      setResult(created);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "内容生成失败"); }
    finally { setCreating(false); }
  };

  const toggleChannel = (value: string) => setChannels((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  const contextLabel = useMemo(() => `${selectedSegment?.name || publicAudience || "未选择受众"} / ${selectedProduct?.name || "未选择产品"}`, [selectedSegment, selectedProduct, publicAudience]);

  return <section className="de-acquisition-workspace de-creation-workspace">
    <header className="de-acquisition-section-head"><div><p>创作工作台</p><h2>从客群简报生成统一主题内容</h2><span>文案、海报和视频共享同一客群、事实、品牌口径与行动号召。</span></div><button className="de-secondary-button" onClick={onOpenAssets}>查看资产库 →</button></header>
    <div className="de-creation-context-bar"><span>当前可见上下文</span><strong>{contextLabel}</strong><small>切换客群或产品后，生成上下文同步变化</small></div>
    <div className="de-creation-layout">
      <div className="de-creation-form">
        <ModelConfigurationGuard configuration={configuration} loading={contextLoading} />
        <section className="de-creation-block"><header><span>1</span><div><h3>选择内容形式</h3><p>付费图片和视频会在确认后才创建任务。</p></div></header><div className="de-content-type-picker"><button className={assetType === "copy" ? "active" : ""} onClick={() => setAssetType("copy")}><b>文</b><strong>营销文案</strong><small>使用当前 LLM</small></button><button className={assetType === "poster" ? "active" : ""} onClick={() => setAssetType("poster")}><b>图</b><strong>活动海报</strong><small>gpt-image-2.0</small></button><button className={assetType === "video" ? "active" : ""} onClick={() => setAssetType("video")}><b>影</b><strong>营销视频</strong><small>seedance 2.0</small></button></div></section>
        <section className="de-creation-block"><header><span>2</span><div><h3>确认客群与产品</h3><p>固定快照用于内容检查和后续效果复盘。</p></div></header><div className="de-brief-grid"><label><span>已保存客群</span><select value={segmentId} onChange={(event) => { setSegmentId(event.target.value); if (event.target.value) setPublicAudience(""); }}><option value="">明确的公开受众</option>{segments.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.latestSnapshot?.metrics.totalProfiles ?? 0}人）</option>)}</select></label>{!segmentId && <label><span>公开受众描述</span><input value={publicAudience} onChange={(event) => setPublicAudience(event.target.value)} placeholder="例如：关注边缘算力部署的制造业管理者" /></label>}<label><span>产品资料</span><select value={productId} onChange={(event) => setProductId(event.target.value)}><option value="">请选择</option>{products.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label><span>活动名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="系统可自动生成" /></label><label><span>活动目标</span><input value={objective} onChange={(event) => setObjective(event.target.value)} /></label><label><span>行动号召</span><input value={callToAction} onChange={(event) => setCallToAction(event.target.value)} /></label></div>{segments.length === 0 && <button className="de-inline-link" onClick={onOpenSegments}>还没有客群？先去建立动态客群 →</button>}{products.length === 0 && <a className="de-inline-link" href="/digital-employee/marketing-materials">请先维护营销产品资料 →</a>}</section>
        <section className="de-creation-block"><header><span>3</span><div><h3>渠道与创作要求</h3><p>内容不会自动发布；投放后需在资产库明确记录。</p></div></header><div className="de-channel-picker">{CHANNELS.map((channel) => <button key={channel} className={channels.includes(channel) ? "active" : ""} onClick={() => toggleChannel(channel)}>{channels.includes(channel) ? "✓ " : ""}{channel}</button>)}</div>{assetType === "video" && <label className="de-duration-picker"><span>视频时长</span>{([15, 30, 60] as const).map((value) => <button key={value} className={durationSeconds === value ? "active" : ""} onClick={() => setDurationSeconds(value)}>{value}s</button>)}</label>}<label className="de-creation-prompt"><span>自然语言创作要求</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：为下周线上分享会生成一套朋友圈文案，强调部署简单，语气专业克制，不使用未确认性能数字。" /></label></section>
        {error && <div className="de-inline-error"><span>{error}</span></div>}
        {mediaBlocked && <p className="de-creation-blocker">当前固定{assetType === "poster" ? "图像" : "视频"}模型未配置，请先前往灵渠 TokenHub 配置。</p>}
        <button className="de-primary-button de-create-submit" disabled={!canSubmit} onClick={() => void submit()}>{creating ? (assetType === "copy" ? "正在撰写文案…" : "正在创建生成任务…") : `确认简报并生成${assetType === "copy" ? "文案" : assetType === "poster" ? "海报" : "视频"}`}</button>
      </div>
      <aside className="de-creation-canvas"><header><div><p>内容生成画布</p><h3>{result?.title || "预览与版本"}</h3></div>{result?.generationStatus === "ready" && <span>已保存到资产库</span>}</header>{!result ? <div className="de-canvas-empty"><span>✦</span><strong>确认左侧简报后开始生成</strong><p>生成结果会自动成为营销资产，但不会自动视为已投放。</p></div> : <CreationResult asset={result} onOpenAssets={onOpenAssets} />}</aside>
    </div>
  </section>;
}

function CreationResult({ asset, onOpenAssets }: { asset: MarketingAsset; onOpenAssets: () => void }) {
  if (["pending", "running"].includes(asset.generationStatus)) return <div className="de-canvas-generating"><span>◌</span><strong>正在生成{asset.assetType === "video" ? "视频" : "海报"}</strong><p>任务已保存，可以离开本页后在资产库继续查看。</p></div>;
  if (["failed", "cancelled"].includes(asset.generationStatus)) return <div className="de-canvas-generating failed"><span>!</span><strong>生成未完成</strong><p>请检查模型配置后重新生成。</p></div>;
  return <div className="de-canvas-result">{asset.assetType === "text" ? <pre>{asset.content}</pre> : asset.assetType === "video" && asset.fileUrl ? <video src={asset.fileUrl} controls /> : asset.fileUrl ? <img src={asset.fileUrl} alt={asset.title} /> : null}<div><span>模型 {asset.modelId}</span><span>客群内容 · 不含单客身份</span></div><footer>{asset.fileUrl && <a className="de-secondary-button" href={asset.fileUrl} download>下载文件</a>}<button className="de-primary-button" onClick={onOpenAssets}>前往资产库管理投放</button></footer></div>;
}

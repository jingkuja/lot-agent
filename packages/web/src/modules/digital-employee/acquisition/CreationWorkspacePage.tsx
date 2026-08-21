import { useEffect, useMemo, useRef, useState } from "react";
import { api, type KnowledgeBaseRef, type PickedFile } from "../../../api/client.js";
import { InputBox, type InputBoxHandle } from "../../../components/InputBox.js";
import type { ImageSettings, VideoSettings } from "../../../components/MediaSettings.js";
import type { MarketingProduct } from "../types.js";
import type {
  AcquisitionModelConfiguration, CustomerSegment, MarketingAsset, MarketingCampaignDetail, MarketingCampaignSummary,
} from "../types.js";
import { listedAcquisitionModels, pickAcquisitionModel, readStoredAcquisitionModels, writeStoredAcquisitionModels } from "./acquisition-models.js";
import { ModelConfigurationGuard } from "./ModelConfigurationGuard.js";

export interface CreationSeed {
  nonce?: number;
  recommendationId?: string;
  parentAssetId?: string;
  campaignId?: string;
  segmentId?: string;
  publicAudience?: string;
  productId?: string;
  title?: string;
  prompt?: string;
  channels?: string[];
  assetType?: "copy" | "poster" | "video";
  durationSeconds?: number;
}

const CHANNELS = ["朋友圈", "公众号", "私域群", "视频号", "抖音/快手", "小红书", "活动页"];
const ACQUISITION_VIDEO_DURATIONS = ["10秒", "15秒"] as const;

export function CreationWorkspacePage({ seed, onOpenAssets, onOpenSegments, onOpenCampaigns }: {
  seed?: CreationSeed; onOpenAssets: () => void; onOpenSegments: () => void; onOpenCampaigns?: () => void;
}) {
  const [segments, setSegments] = useState<CustomerSegment[]>([]);
  const [products, setProducts] = useState<MarketingProduct[]>([]);
  const [campaigns, setCampaigns] = useState<MarketingCampaignSummary[]>([]);
  const [campaign, setCampaign] = useState<MarketingCampaignDetail | null>(null);
  const [configuration, setConfiguration] = useState<AcquisitionModelConfiguration | null>(null);
  const [imageModelId, setImageModelId] = useState("");
  const [videoModelId, setVideoModelId] = useState("");
  const [contextLoading, setContextLoading] = useState(true);
  const [assetType, setAssetType] = useState<"copy" | "poster" | "video">("copy");
  const [campaignId, setCampaignId] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [publicAudience, setPublicAudience] = useState("");
  const [productId, setProductId] = useState("");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("获得更多咨询和有效线索");
  const [channels, setChannels] = useState<string[]>(["朋友圈"]);
  const [callToAction, setCallToAction] = useState("了解详情或预约咨询");
  const [prompt, setPrompt] = useState("");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseRef[]>([]);
  const composerRef = useRef<InputBoxHandle>(null);
  const [recommendationId, setRecommendationId] = useState<string | undefined>();
  const [parentAssetId, setParentAssetId] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MarketingAsset | null>(null);

  const loadCampaign = async (id: string) => {
    const next = await api.getMarketingCampaign(id);
    setCampaign(next);
    setCampaignId(next.id);
    setTitle(next.name);
    setObjective(next.objective);
    setChannels(next.channels.length ? next.channels : ["朋友圈"]);
    setCallToAction(next.callToAction);
    if (next.productId) setProductId(next.productId);
    return next;
  };

  useEffect(() => {
    let active = true;
    setContextLoading(true);
    void Promise.all([
      api.listCustomerSegments(),
      api.listMarketingProducts({ status: "active", page: 1, limit: 100 }),
      api.getAcquisitionModelConfiguration(),
      api.listMarketingCampaigns({ limit: 50 }),
    ]).then(([segmentResult, productResult, modelResult, campaignResult]) => {
      if (!active) return;
      setSegments(segmentResult.items);
      setProducts(productResult.items);
      setConfiguration(modelResult);
      const stored = readStoredAcquisitionModels();
      const nextImage = pickAcquisitionModel(listedAcquisitionModels(modelResult, "image"), stored.image, modelResult.imageModelId);
      const nextVideo = pickAcquisitionModel(listedAcquisitionModels(modelResult, "video"), stored.video, modelResult.videoModelId);
      setImageModelId(nextImage);
      setVideoModelId(nextVideo);
      writeStoredAcquisitionModels({ image: nextImage || undefined, video: nextVideo || undefined });
      setCampaigns(campaignResult.items);
      setSegmentId((current) => current || segmentResult.items[0]?.id || "");
      setProductId((current) => current || productResult.items[0]?.id || "");
    }).catch((reason) => active && setError(reason instanceof Error ? reason.message : "创作上下文加载失败"))
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
    setRecommendationId(seed.recommendationId);
    setParentAssetId(seed.parentAssetId);
    setResult(null);
    if (seed.campaignId) void loadCampaign(seed.campaignId).catch((reason) => setError(reason instanceof Error ? reason.message : "活动加载失败"));
    else { setCampaignId(""); setCampaign(null); }
  }, [seed?.nonce]);

  useEffect(() => {
    if (!campaignId) return;
    const pending = campaign && Object.values(campaign.assets).flat().some((item) => ["pending", "running"].includes(item.generationStatus));
    const generating = result && ["pending", "running"].includes(result.generationStatus);
    if (!pending && !generating) return;
    const timer = window.setInterval(() => {
      void loadCampaign(campaignId).then((next) => {
        if (result) setResult(Object.values(next.assets).flat().find((item) => item.id === result.id) ?? result);
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [campaignId, campaign, result?.id, result?.generationStatus]);

  const selectedSegment = segments.find((item) => item.id === segmentId);
  const selectedProduct = products.find((item) => item.id === productId);
  const mediaBlocked = assetType === "poster" ? !imageModelId : assetType === "video" ? !videoModelId : false;
  const canSubmit = prompt.trim().length >= 2 && productId && (campaignId || segmentId || publicAudience.trim()) && channels.length && callToAction.trim() && !mediaBlocked && !creating;
  const contextLabel = useMemo(
    () => `${campaign?.name || title || "新活动"} · ${selectedSegment?.name || publicAudience || campaign?.audienceDescription || "未选择受众"} / ${selectedProduct?.name || campaign?.productName || "未选择产品"}`,
    [campaign, title, selectedSegment, selectedProduct, publicAudience]
  );

  const submit = async () => {
    if (!canSubmit) return;
    const imageError = composerRef.current?.getImageSettingsError();
    if (assetType === "poster" && imageError) { setError(imageError); return; }
    const missing = composerRef.current?.getMissingMentions() ?? [];
    if (missing.length) { setError(`当前提示词尚未写出 ${missing.join("、")}`); return; }
    setCreating(true); setError(null);
    try {
      const files = composerRef.current?.getFiles() ?? [];
      const settings = composerRef.current?.getSettings();
      const uploaded = files.length
        ? await Promise.all(files.map(async (item) => ({ slot: item.slot, uploaded: await api.uploadFile(item.file) })))
        : [];
      const created = await api.createMarketingAsset({
        assetType, prompt: prompt.trim(),
        campaignId: campaignId || undefined,
        segmentId: campaignId ? undefined : (segmentId || undefined),
        publicAudience: campaignId || segmentId ? undefined : publicAudience.trim(),
        productId, recommendationId, parentAssetId, objective, channels, callToAction,
        title: title.trim() || undefined,
        modelId: assetType === "poster" ? imageModelId || undefined : assetType === "video" ? videoModelId || undefined : undefined,
        knowledgeBaseIds: assetType === "copy" ? knowledgeBases.map((item) => item.id) : undefined,
        ...composerPayload(assetType, uploaded, settings),
      });
      setResult(created);
      setParentAssetId(undefined);
      if (created.campaignId) {
        setCampaignId(created.campaignId);
        const next = await api.getMarketingCampaign(created.campaignId);
        setCampaign(next);
        setCampaigns((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [next, ...current]);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "内容生成失败"); }
    finally { setCreating(false); }
  };

  const pickCampaign = async (id: string) => {
    if (!id) { setCampaignId(""); setCampaign(null); return; }
    try { await loadCampaign(id); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "活动加载失败"); }
  };

  const selectVersion = async (kind: "copy" | "poster" | "video", assetId: string) => {
    if (!campaignId) return;
    const next = await api.updateMarketingCampaign(campaignId, { selectedAssets: { [kind]: assetId } });
    setCampaign(next);
  };

  const toggleChannel = (value: string) => setChannels((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);

  return <section className="de-acquisition-workspace de-creation-workspace">
    <header className="de-acquisition-section-head"><div><p>创作工作台</p><h2>把文案、海报和视频放进同一次营销活动</h2><span>先确认活动，再追加素材；同一活动共享客群快照、简报和行动号召。</span></div><div className="de-creation-head-actions">{onOpenCampaigns && <button className="de-secondary-button" onClick={onOpenCampaigns}>活动列表</button>}<button className="de-secondary-button" onClick={onOpenAssets}>查看资产库 →</button></div></header>
    <div className="de-creation-context-bar"><span>当前活动</span><strong>{contextLabel}</strong><small>{campaign ? "后续生成会追加到该活动，不再新建快照" : "第一次生成会创建活动；之后可继续生成海报或视频"}</small></div>
    <div className="de-creation-layout">
      <div className="de-creation-form">
        <ModelConfigurationGuard
          configuration={configuration}
          loading={contextLoading}
          imageModelId={imageModelId}
          videoModelId={videoModelId}
          onImageModelChange={(id) => { setImageModelId(id); writeStoredAcquisitionModels({ image: id }); }}
          onVideoModelChange={(id) => { setVideoModelId(id); writeStoredAcquisitionModels({ video: id }); }}
        />
        <section className="de-creation-block"><header><span>1</span><div><h3>选择或创建营销活动</h3><p>已有活动用于追加素材；空白则在首次生成时创建。</p></div></header>
          <div className="de-brief-grid"><label><span>营销活动</span><select value={campaignId} onChange={(event) => void pickCampaign(event.target.value)}><option value="">新建本次活动</option>{campaigns.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.assetCount} 项素材）</option>)}</select></label><label><span>活动名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="系统可按产品自动生成" /></label></div>
        </section>
        <section className="de-creation-block"><header><span>2</span><div><h3>选择内容形式</h3><p>同一活动可分别生成文案、海报和视频。</p></div></header><div className="de-content-type-picker"><button className={assetType === "copy" ? "active" : ""} onClick={() => setAssetType("copy")}><b>文</b><strong>营销文案</strong><small>知识库 / 上传文件</small></button><button className={assetType === "poster" ? "active" : ""} onClick={() => setAssetType("poster")}><b>图</b><strong>活动海报</strong><small>{imageModelId || "需选择图像模型"}</small></button><button className={assetType === "video" ? "active" : ""} onClick={() => setAssetType("video")}><b>影</b><strong>营销视频</strong><small>{videoModelId || "需选择视频模型"}</small></button></div></section>
        <section className="de-creation-block"><header><span>3</span><div><h3>确认客群与产品</h3><p>已有活动沿用当时固定的客群快照。</p></div></header><div className="de-brief-grid"><label><span>已保存客群</span><select value={segmentId} disabled={Boolean(campaignId)} onChange={(event) => { setSegmentId(event.target.value); if (event.target.value) setPublicAudience(""); }}><option value="">明确的公开受众</option>{segments.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.latestSnapshot?.metrics.totalProfiles ?? 0}人）</option>)}</select></label>{!segmentId && !campaignId && <label><span>公开受众描述</span><input value={publicAudience} onChange={(event) => setPublicAudience(event.target.value)} placeholder="例如：关注边缘算力部署的制造业管理者" /></label>}<label><span>产品资料</span><select value={productId} disabled={Boolean(campaignId)} onChange={(event) => setProductId(event.target.value)}><option value="">请选择</option>{products.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label><span>活动目标</span><input value={objective} onChange={(event) => setObjective(event.target.value)} /></label><label><span>行动号召</span><input value={callToAction} onChange={(event) => setCallToAction(event.target.value)} /></label></div>{segments.length === 0 && <button className="de-inline-link" onClick={onOpenSegments}>还没有客群？先去建立动态客群 →</button>}{products.length === 0 && <a className="de-inline-link" href="/digital-employee/marketing-materials">请先维护营销产品资料 →</a>}</section>
        <section className="de-creation-block"><header><span>4</span><div><h3>渠道与创作要求</h3><p>内容不会自动发布；投放后需在资产库明确记录。</p></div></header>
          <div className="de-channel-picker">{CHANNELS.map((channel) => <button key={channel} className={channels.includes(channel) ? "active" : ""} onClick={() => toggleChannel(channel)}>{channels.includes(channel) ? "✓ " : ""}{channel}</button>)}</div>
          <div className="de-creation-prompt">
            <span>{assetType === "copy" ? "文案要求，可关联知识库并上传参考文件" : assetType === "poster" ? "海报要求，可上传参考图并调整分辨率与质量" : "视频要求，可上传参考素材并调整时长、比例与清晰度"}</span>
            <div className="de-creation-composer">
              <InputBox
                key={assetType}
                ref={composerRef}
                embedded
                mode={assetType === "poster" ? "image" : assetType === "video" ? "video" : "default"}
                value={prompt}
                onChange={setPrompt}
                disabled={creating}
                selectedModel={assetType === "poster" ? imageModelId || null : assetType === "video" ? videoModelId || null : null}
                allowKnowledgeBase={assetType === "copy"}
                knowledgeBases={assetType === "copy" ? knowledgeBases : []}
                onKnowledgeBasesChange={setKnowledgeBases}
                videoDurations={assetType === "video" ? ACQUISITION_VIDEO_DURATIONS : undefined}
                placeholder={
                  assetType === "copy"
                    ? "例如：为下周线上分享会生成一套朋友圈文案，强调部署简单，语气专业克制，不使用未确认性能数字。"
                    : assetType === "poster"
                      ? "描述海报画面、主标题和行动号召，可上传参考图。"
                      : "描述视频画面与节奏，可上传参考图、参考视频或首尾帧。"
                }
              />
            </div>
          </div>
        </section>
        {error && <div className="de-inline-error"><span>{error}</span></div>}
        {mediaBlocked && <p className="de-creation-blocker">当前没有可用的{assetType === "poster" ? "图像" : "视频"}模型，请先前往 TokenHub 配置。</p>}
        <button className="de-primary-button de-create-submit" disabled={!canSubmit} onClick={() => void submit()}>{creating ? (assetType === "copy" ? "正在撰写文案…" : "正在创建生成任务…") : campaignId ? `追加生成${assetType === "copy" ? "文案" : assetType === "poster" ? "海报" : "视频"}` : `创建活动并生成${assetType === "copy" ? "文案" : assetType === "poster" ? "海报" : "视频"}`}</button>
      </div>
      <aside className="de-creation-canvas"><header><div><p>活动内容包</p><h3>{campaign?.name || result?.title || "预览与版本"}</h3></div>{campaign && <span>{campaign.assetCount} 项素材</span>}</header>{campaign ? <CampaignPack campaign={campaign} focusId={result?.id} onSelect={selectVersion} onOpenAssets={onOpenAssets} /> : !result ? <div className="de-canvas-empty"><span>✦</span><strong>确认左侧简报后开始生成</strong><p>第一次生成会创建活动；文案、海报和视频可以追加到同一活动。</p></div> : <CreationResult asset={result} onOpenAssets={onOpenAssets} />}</aside>
    </div>
  </section>;
}

function composerPayload(
  assetType: "copy" | "poster" | "video",
  uploaded: Array<{ slot?: PickedFile["slot"]; uploaded: Awaited<ReturnType<typeof api.uploadFile>> }>,
  settings?: ImageSettings | VideoSettings,
) {
  if (assetType === "copy") {
    return {
      attachments: uploaded.map((item) => item.uploaded),
    };
  }
  if (assetType === "poster") {
    const imageSettings = settings as ImageSettings | undefined;
    return {
      attachments: uploaded.map((item) => item.uploaded),
      mediaSettings: imageSettings
        ? { size: imageSettings.size, n: imageSettings.n, quality: imageSettings.quality }
        : undefined,
    };
  }
  const videoSettings = settings as VideoSettings | undefined;
  const urlsFor = (slot: PickedFile["slot"]) => uploaded.filter((item) => item.slot === slot).map((item) => item.uploaded.url);
  const inputReference = urlsFor("video_reference_image");
  const referenceVideo = urlsFor("video_reference_video");
  const referenceAudio = urlsFor("video_reference_audio");
  return {
    mediaSettings: videoSettings
      ? { size: videoSettings.size, durationSec: videoSettings.durationSec, ratio: videoSettings.ratio }
      : undefined,
    durationSeconds: videoSettings?.durationSec,
    input_reference: inputReference.length ? inputReference : undefined,
    reference_video: referenceVideo.length ? referenceVideo : undefined,
    reference_audio: referenceAudio.length ? referenceAudio : undefined,
    first_frame: urlsFor("video_first_frame")[0],
    last_frame: urlsFor("video_last_frame")[0],
  };
}

function CampaignPack({ campaign, focusId, onSelect, onOpenAssets }: {
  campaign: MarketingCampaignDetail; focusId?: string;
  onSelect: (kind: "copy" | "poster" | "video", assetId: string) => void; onOpenAssets: () => void;
}) {
  return <div className="de-campaign-pack">
    {(["copy", "poster", "video"] as const).map((kind) => {
      const items = campaign.assets[kind];
      const selectedId = campaign.selectedAssets[kind];
      const selected = items.find((item) => item.id === selectedId) ?? items[0];
      return <section key={kind} className="de-campaign-pack-group">
        <header><strong>{kind === "copy" ? "文案" : kind === "poster" ? "海报" : "视频"}</strong><span>{items.length ? `${items.length} 个版本` : "尚未生成"}</span></header>
        {!selected ? <p className="de-campaign-pack-empty">还没有这一类素材。在左侧选择形式后追加生成。</p> : <CreationResult asset={selected} onOpenAssets={onOpenAssets} compact />}
        {items.length > 1 && <div className="de-version-pills">{items.map((item) => <button key={item.id} className={(selected?.id === item.id ? "active" : "") + (item.id === focusId ? " current" : "")} onClick={() => void onSelect(kind, item.id)}>v{item.version}{item.id === selectedId ? " · 选用" : ""}</button>)}</div>}
      </section>;
    })}
    <footer className="de-campaign-pack-results">曝光 {campaign.results.impressions} · 互动 {campaign.results.interactions} · 转化 {campaign.results.conversions} · 线索 {campaign.results.leads}</footer>
  </div>;
}

function CreationResult({ asset, onOpenAssets, compact }: { asset: MarketingAsset; onOpenAssets: () => void; compact?: boolean }) {
  if (["pending", "running"].includes(asset.generationStatus)) return <div className="de-canvas-generating"><span>◌</span><strong>正在生成{asset.assetType === "video" ? "视频" : asset.assetType === "text" ? "文案" : "海报"}</strong><p>任务已保存到当前活动。</p></div>;
  if (["failed", "cancelled"].includes(asset.generationStatus)) return <div className="de-canvas-generating failed"><span>!</span><strong>生成未完成</strong><p>请检查模型配置后重新生成。</p></div>;
  return <div className={`de-canvas-result${compact ? " compact" : ""}`}>{asset.assetType === "text" ? <pre>{asset.content}</pre> : asset.assetType === "video" && asset.fileUrl ? <video src={asset.fileUrl} controls /> : asset.fileUrl ? <img src={asset.fileUrl} alt={asset.title} /> : null}<div><span>模型 {asset.modelId} · v{asset.version}</span><span>客群内容 · 不含单客身份</span></div>{!compact && <footer>{asset.fileUrl && <a className="de-secondary-button" href={asset.fileUrl} download>下载文件</a>}<button className="de-primary-button" onClick={onOpenAssets}>前往资产库管理投放</button></footer>}</div>;
}

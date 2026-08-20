import { useState } from "react";
import { api } from "../../../api/client.js";
import type { AssetDeployment, DeploymentPlatform, MarketingAsset } from "../types.js";

const PLATFORMS: Array<[DeploymentPlatform, string]> = [
  ["moments", "朋友圈"], ["wechat_official", "公众号"], ["channels", "视频号"],
  ["douyin_kuaishou", "抖音 / 快手"], ["xiaohongshu", "小红书"], ["ad_platform", "广告平台"], ["other", "其他"],
];

export function DeploymentManager({ asset, onClose, onChanged }: { asset: MarketingAsset; onClose: () => void; onChanged: () => void }) {
  const [platform, setPlatform] = useState<DeploymentPlatform>("moments");
  const [customPlatform, setCustomPlatform] = useState("");
  const [deployedAt, setDeployedAt] = useState(() => localDateTime(new Date()));
  const [saving, setSaving] = useState(false);
  const [feedbackFor, setFeedbackFor] = useState<AssetDeployment | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await api.saveAssetDeployment(asset.id, { platform, customPlatform: platform === "other" ? customPlatform : undefined, status: "deployed", deployedAt: new Date(deployedAt).toISOString() });
      onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "投放状态保存失败"); }
    finally { setSaving(false); }
  };
  const end = async (entry: AssetDeployment) => {
    await api.saveAssetDeployment(asset.id, {
      platform: entry.platform,
      customPlatform: entry.customPlatform ?? undefined,
      status: "ended",
      deployedAt: entry.deployedAt,
    });
    onChanged();
  };

  return <div className="de-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="de-modal de-deployment-modal" role="dialog" aria-modal="true">
      <header className="de-modal-head"><div><p className="de-eyebrow">投放管理</p><h2>{asset.title}</h2></div><button className="de-icon-button" onClick={onClose}>×</button></header>
      <div className="de-deployment-create">
        <h3>标记一次投放</h3>
        <div className="de-deployment-fields"><label><span>平台</span><select value={platform} onChange={(event) => setPlatform(event.target.value as DeploymentPlatform)}>{PLATFORMS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>{platform === "other" && <label><span>平台名称</span><input value={customPlatform} onChange={(event) => setCustomPlatform(event.target.value)} /></label>}<label><span>投放时间</span><input type="datetime-local" value={deployedAt} onChange={(event) => setDeployedAt(event.target.value)} /></label><button className="de-primary-button" disabled={saving || (platform === "other" && !customPlatform.trim())} onClick={() => void save()}>{saving ? "保存中…" : "确认已投放"}</button></div>
        {error && <p className="de-field-error">{error}</p>}
      </div>
      <div className="de-deployment-list"><h3>平台记录</h3>{asset.deployments.length === 0 ? <p className="de-deployment-empty">还没有投放记录。系统不会把“生成完成”自动视为“已投放”。</p> : asset.deployments.map((entry) => <article key={entry.id}><div><strong>{platformName(entry)}</strong><span>{entry.status === "pending" ? "待投放" : entry.status === "ended" ? "已结束" : "已投放"} · {entry.deployedAt ? date(entry.deployedAt) : "未填写时间"}</span></div><div className="de-deployment-metrics">{entry.feedback.length ? <><span>曝光 <b>{sum(entry, "impressions")}</b></span><span>互动 <b>{sum(entry, "interactions")}</b></span><span>转化 <b>{sum(entry, "conversions")}</b></span></> : <span>尚未记录平台反馈</span>}</div><div className="de-deployment-actions"><button className="de-secondary-button" onClick={() => setFeedbackFor(entry)}>＋ 添加反馈</button>{entry.status === "deployed" && <button className="de-quiet-button" onClick={() => void end(entry)}>结束投放</button>}</div></article>)}</div>
      {feedbackFor && <FeedbackDialog deployment={feedbackFor} onClose={() => setFeedbackFor(null)} onSaved={() => { setFeedbackFor(null); onChanged(); }} />}
    </section>
  </div>;
}

function FeedbackDialog({ deployment, onClose, onSaved }: { deployment: AssetDeployment; onClose: () => void; onSaved: () => void }) {
  const [impressions, setImpressions] = useState(""); const [interactions, setInteractions] = useState(""); const [conversions, setConversions] = useState(""); const [feedbackText, setFeedbackText] = useState(""); const [saving, setSaving] = useState(false);
  const save = async () => { setSaving(true); try { await api.addDeploymentFeedback(deployment.id, { impressions: count(impressions), interactions: count(interactions), conversions: count(conversions), feedbackText }); onSaved(); } finally { setSaving(false); } };
  return <div className="de-subdialog"><header><strong>记录平台反馈</strong><button onClick={onClose}>×</button></header><div className="de-feedback-fields"><label><span>曝光 / 阅读 / 播放</span><input type="number" min="0" value={impressions} onChange={(event) => setImpressions(event.target.value)} /></label><label><span>互动</span><input type="number" min="0" value={interactions} onChange={(event) => setInteractions(event.target.value)} /></label><label><span>咨询 / 留资 / 转化</span><input type="number" min="0" value={conversions} onChange={(event) => setConversions(event.target.value)} /></label><label className="wide"><span>文字反馈</span><textarea value={feedbackText} onChange={(event) => setFeedbackText(event.target.value)} placeholder="主要正向反馈、异议或风险" /></label></div><footer><button className="de-secondary-button" onClick={onClose}>取消</button><button className="de-primary-button" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存反馈"}</button></footer></div>;
}

function count(value: string) { return value === "" ? null : Math.max(0, Number.parseInt(value, 10) || 0); }
function platformName(entry: AssetDeployment) { return entry.customPlatform || PLATFORMS.find(([value]) => value === entry.platform)?.[1] || entry.platform; }
function date(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function sum(entry: AssetDeployment, key: "impressions" | "interactions" | "conversions") { return entry.feedback.reduce((total, item) => total + (item[key] ?? 0), 0); }
function localDateTime(value: Date) { const offset = value.getTimezoneOffset() * 60_000; return new Date(value.getTime() - offset).toISOString().slice(0, 16); }

import type { CampaignRecommendation } from "../types.js";

export function RecommendationCard({ item, onCreate, onIgnore }: { item: CampaignRecommendation; onCreate: () => void; onIgnore: () => void }) {
  return <article className={`de-recommendation-card type-${item.type}`}>
    <header><span>{item.type === "copy" ? "文" : item.type === "poster" ? "图" : "影"}</span><div><small>{item.targetSegmentDescription}</small><h4>{item.theme}</h4></div></header>
    <dl><div><dt>匹配产品</dt><dd>{item.productName || "待确认产品"}</dd></div><div><dt>建议渠道</dt><dd>{item.suggestedChannels.join(" + ") || "待确认"}</dd></div>{item.durationSeconds && <div><dt>建议时长</dt><dd>{item.durationSeconds} 秒</dd></div>}</dl>
    {item.corePoints.length > 0 && <div className="de-recommendation-points">{item.corePoints.map((point) => <span key={point}>{point}</span>)}</div>}
    <div className="de-recommendation-reason"><strong>推荐理由</strong>{item.reasoning.map((reason) => <p key={reason}>• {reason}</p>)}</div>
    <footer><button className="de-primary-button" onClick={onCreate}>一键带入创作</button><button className="de-quiet-button" onClick={onIgnore}>忽略此条</button></footer>
  </article>;
}

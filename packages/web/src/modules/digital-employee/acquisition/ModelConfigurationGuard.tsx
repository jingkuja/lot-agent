import type { AcquisitionModelConfiguration } from "../types.js";

export function ModelConfigurationGuard({ configuration, loading }: { configuration: AcquisitionModelConfiguration | null; loading: boolean }) {
  if (loading) return <div className="de-model-guard loading">正在检查图像与视频模型权限…</div>;
  if (!configuration) return <div className="de-model-guard missing"><strong>模型配置暂时无法读取</strong><span>文案仍可生成；海报和视频将在配置可用后开放。</span></div>;
  const complete = configuration.image && configuration.video;
  return <div className={`de-model-guard ${complete ? "ready" : "missing"}`}>
    <div><span>{complete ? "✓" : "!"}</span><p><strong>{complete ? "生成模型已就绪" : "模型配置提示"}</strong><small>获客宝固定使用指定图像和视频模型，不提供其他模型选择。</small></p></div>
    <ul><li><i className={configuration.image ? "ok" : "no"} />图像：gpt-image-2.0 <b>{configuration.image ? "可用" : "未配置"}</b></li><li><i className={configuration.video ? "ok" : "no"} />视频：seedance 2.0 <b>{configuration.video ? "可用" : "未配置"}</b></li></ul>
    {!complete && <a className="de-secondary-button" href={configuration.configurationUrl} target="_blank" rel="noreferrer">前往灵渠 TokenHub 配置 ↗</a>}
  </div>;
}

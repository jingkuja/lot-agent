import { listedAcquisitionModels } from "./acquisition-models.js";
import type { AcquisitionModelConfiguration, AcquisitionModelOption } from "../types.js";

export function ModelConfigurationGuard({
  configuration,
  loading,
  imageModelId,
  videoModelId,
  onImageModelChange,
  onVideoModelChange,
}: {
  configuration: AcquisitionModelConfiguration | null;
  loading: boolean;
  imageModelId: string;
  videoModelId: string;
  onImageModelChange: (id: string) => void;
  onVideoModelChange: (id: string) => void;
}) {
  if (loading) return <div className="de-model-guard loading">正在检查 LLM、图像与视频模型权限…</div>;
  if (!configuration) return <div className="de-model-guard missing"><strong>模型配置暂时无法读取</strong><span>模型配置可用后才能生成相应内容。</span></div>;
  const llmModels = listedAcquisitionModels(configuration, "llm");
  const imageModels = listedAcquisitionModels(configuration, "image");
  const videoModels = listedAcquisitionModels(configuration, "video");
  const complete = llmModels.length > 0 && imageModels.length > 0 && videoModels.length > 0;
  return <div className={`de-model-guard ${complete ? "ready" : "missing"}`}>
    <div className="de-model-guard-head">
      <span>{complete ? "✓" : "!"}</span>
      <p>
        <strong>{complete ? "生成模型已就绪" : "模型配置提示"}</strong>
        <small>平台会自动提供订阅模型；如暂时缺少某类模型，请稍后重试或联系管理员。</small>
      </p>
    </div>
    <div className="de-model-guard-pickers">
      <ModelSelect
        label="图像模型"
        value={imageModelId}
        models={imageModels}
        emptyLabel="暂无可用图像模型"
        onChange={onImageModelChange}
      />
      <ModelSelect
        label="视频模型"
        value={videoModelId}
        models={videoModels}
        emptyLabel="暂无可用视频模型"
        onChange={onVideoModelChange}
      />
    </div>
  </div>;
}

function ModelSelect({
  label, value, models, emptyLabel, onChange,
}: {
  label: string;
  value: string;
  models: AcquisitionModelOption[];
  emptyLabel: string;
  onChange: (id: string) => void;
}) {
  const empty = models.length === 0;
  return <label>
    <span>{label}</span>
    <select
      value={empty ? "" : value}
      disabled={empty}
      aria-label={label}
      onChange={(event) => onChange(event.target.value)}
    >
      {empty ? <option value="">{emptyLabel}</option> : models.map((model) => (
        <option key={model.id} value={model.id}>{model.label || model.id}</option>
      ))}
    </select>
  </label>;
}

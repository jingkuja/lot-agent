export const LLM_MODEL_REQUIRED_MESSAGE = "没有获取到 LLM 模型，请稍后重试；如持续出现，请联系管理员检查平台模型目录。";

interface LlmModelRequiredModalProps {
  title: string;
  onClose: () => void;
}

export function LlmModelRequiredModal({ title, onClose }: LlmModelRequiredModalProps) {
  return (
    <div className="de-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="de-modal llm-model-required-modal" role="dialog" aria-modal="true" aria-labelledby="llm-model-required-title">
        <header className="de-modal-head">
          <div>
            <p className="de-eyebrow">模型配置</p>
            <h2 id="llm-model-required-title">{title}</h2>
          </div>
          <button type="button" className="de-icon-button" onClick={onClose} aria-label="关闭提示">×</button>
        </header>
        <div className="de-form">
          <strong className="llm-model-required-heading">没有获取到 LLM 模型</strong>
          <p className="de-field-hint">{LLM_MODEL_REQUIRED_MESSAGE.replace("没有获取到 LLM 模型，", "")}</p>
          <div className="de-modal-actions">
            <button type="button" className="de-primary-button" onClick={onClose}>知道了</button>
          </div>
        </div>
      </section>
    </div>
  );
}

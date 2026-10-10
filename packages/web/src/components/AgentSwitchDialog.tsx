import { useEffect, useId, useRef } from "react";
import { useI18n } from "../i18n/index.js";

interface Props {
  currentName: string;
  nextName: string;
  hasDraft: boolean;
  isStreaming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function AgentSwitchDialog({ currentName, nextName, hasDraft, isStreaming, onCancel, onConfirm }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog ref={dialog} className="agent-switch-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <h2 id={titleId}>{t("切换到 {0}？", [nextName])}</h2>
      <p id={descriptionId}>{t("是否离开当前的{0}，前往{1}？已发送的对话会保留在历史记录中。", [currentName, nextName])}</p>
      {isStreaming && <p>{t("当前任务会继续运行，可从历史记录返回查看。")}</p>}
      {hasDraft && <p>{t("切换后，未发送的文字和附件将被清空。")}</p>}
      <div className="agent-switch-dialog-actions">
        <button type="button" autoFocus onClick={onCancel}>{t("留在当前对话")}</button>
        <button type="button" className="primary" onClick={onConfirm}>{t("离开并切换")}</button>
      </div>
    </dialog>
  );
}

import { useMemo, useState } from "react";
import type { KnowledgeBase, KnowledgeBaseRef } from "../api/client.js";

interface KnowledgeBaseModalProps {
  items: KnowledgeBase[];
  selected: KnowledgeBaseRef[];
  loading: boolean;
  error: string | null;
  onConfirm: (items: KnowledgeBaseRef[]) => void;
  onClose: () => void;
  onRetry: () => void;
}

const MAX_SELECTED = 5;

export function KnowledgeBaseModal({
  items,
  selected,
  loading,
  error,
  onConfirm,
  onClose,
  onRetry,
}: KnowledgeBaseModalProps) {
  const [selectedIds, setSelectedIds] = useState(() => new Set(selected.map((item) => item.id)));
  const selectedCount = selectedIds.size;
  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)).map(({ id, name }) => ({ id, name })),
    [items, selectedIds]
  );

  return (
    <div className="agent-center-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="knowledge-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="knowledge-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="agent-center-head">
          <div>
            <div className="agent-center-title" id="knowledge-modal-title">选择知识库</div>
            <div className="knowledge-modal-subtitle">最多选择 {MAX_SELECTED} 个，发送时会先改写问题并召回相关资料</div>
          </div>
          <button className="agent-center-close" type="button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="knowledge-modal-body">
          {loading && <div className="knowledge-modal-state">正在加载知识库…</div>}
          {!loading && error && (
            <div className="knowledge-modal-state knowledge-modal-error">
              <span>{error}</span>
              <button type="button" onClick={onRetry}>重新加载</button>
            </div>
          )}
          {!loading && !error && items.length === 0 && (
            <div className="knowledge-modal-state">暂无知识库，请先前往个人知识库创建并导入资料</div>
          )}
          {!loading && !error && items.map((item) => {
            const checked = selectedIds.has(item.id);
            const disabled = !checked && selectedCount >= MAX_SELECTED;
            return (
              <label className={`knowledge-row${checked ? " selected" : ""}${disabled ? " disabled" : ""}`} key={item.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    setSelectedIds((previous) => {
                      const next = new Set(previous);
                      if (next.has(item.id)) next.delete(item.id);
                      else if (next.size < MAX_SELECTED) next.add(item.id);
                      return next;
                    });
                  }}
                />
                <span className="knowledge-row-icon" aria-hidden>▤</span>
                <span className="knowledge-row-main">
                  <span className="knowledge-row-name">{item.name}</span>
                  <span className="knowledge-row-desc">
                    {item.description || "暂无描述"} · {item.availableDocumentCount}/{item.documentCount} 个文档可召回
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <div className="knowledge-modal-footer">
          <span>已选择 {selectedCount} 个</span>
          <div>
            <button className="knowledge-modal-cancel" type="button" onClick={onClose}>取消</button>
            <button
              className="knowledge-modal-confirm"
              type="button"
              onClick={() => { onConfirm(selectedItems); onClose(); }}
              disabled={loading || !!error}
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

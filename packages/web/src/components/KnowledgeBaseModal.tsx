import { KNOWLEDGE_SOURCE_LABELS, DEFAULT_CHAT_SOURCE_TYPES, type KnowledgeSourceType } from "@lot-agent/core/knowledge";
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
  onManage?: () => void;
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
  onManage,
}: KnowledgeBaseModalProps) {
  const [selectedIds, setSelectedIds] = useState(() => new Set(selected.map((item) => item.id)));
  const [sourceTypes, setSourceTypes] = useState<KnowledgeSourceType[]>(selected[0]?.sourceTypes ?? DEFAULT_CHAT_SOURCE_TYPES);
  const selectedCount = selectedIds.size;
  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)).map(({ id, name, source }) => ({ id, name, source, sourceTypes })),
    [items, selectedIds, sourceTypes]
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
            <div className="knowledge-modal-subtitle">为本次对话添加参考资料，让回答更有依据</div>
          </div>
          <button className="agent-center-close" type="button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="knowledge-modal-body">
          {items.some((item) => item.source === "local") && <fieldset className="knowledge-source-filter"><legend>检索资料类型</legend>
            <div className="knowledge-source-options">
              {Object.entries(KNOWLEDGE_SOURCE_LABELS).map(([type, label]) => <label key={type} className="knowledge-source-option"><input type="checkbox" checked={sourceTypes.includes(type as KnowledgeSourceType)} onChange={(e) => setSourceTypes((old) => e.target.checked ? [...old, type as KnowledgeSourceType] : old.filter((v) => v !== type))} /><span>{label}</span></label>)}
            </div>
            <p className="knowledge-source-hint">媒体仅检索手工说明，个人信息需主动勾选。</p>
            {!sourceTypes.length && <p className="knowledge-source-validation" role="status">请至少选择一种资料类型</p>}
          </fieldset>}
          <div className="knowledge-list-heading">
            <div><h3>可用知识库</h3><span>最多选择 {MAX_SELECTED} 个</span></div>
            {onManage && <button className="knowledge-manage-link" type="button" onClick={onManage}>管理个人知识库 <span aria-hidden="true">↗</span></button>}
          </div>
          <div className="knowledge-list">
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
                <span className="knowledge-row-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h13a1 1 0 0 1 1 1v16H6a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Z" /><path d="M3 17a3 3 0 0 1 3-3h13M8 7h7M8 10h5" /></svg></span>
                <span className="knowledge-row-main">
                  <span className="knowledge-row-name">{item.name}</span>
                  <span className="knowledge-row-desc">
                    {item.description || "暂无描述"}
                  </span>
                  <span className="knowledge-row-meta">{item.availableDocumentCount} / {item.documentCount} 个文档可召回</span>
                </span>
              </label>
            );
          })}
          </div>
        </div>
        <div className="knowledge-modal-footer">
          <span className="knowledge-selection-count">已选择 <strong>{selectedCount}</strong> / {MAX_SELECTED} 个</span>
          <div>
            <button className="knowledge-modal-cancel" type="button" onClick={onClose}>取消</button>
            <button
              className="knowledge-modal-confirm"
              type="button"
              onClick={() => { onConfirm(selectedItems); onClose(); }}
              disabled={loading || !!error || !sourceTypes.length}
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

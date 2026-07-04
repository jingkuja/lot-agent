interface KeySettingsModalProps {
  keys: string[];
  activeIndex: number;
  busy: boolean;
  onSelect: (index: number) => void;
  onClose: () => void;
}

/** API-Key 设置弹窗：单选一个激活 key（视觉为 checkbox 列表），选中即切换。
 *  keys 已是遮罩串；组件从不接触原始 key，仅按 index 回传选择。 */
export function KeySettingsModal({ keys, activeIndex, busy, onSelect, onClose }: KeySettingsModalProps) {
  return (
    <div className="agent-center-overlay" onClick={onClose}>
      <div className="agent-center-modal key-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="agent-center-head">
          <h2 className="agent-center-title">API-Key 设置</h2>
          <button className="agent-center-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        {keys.length === 0 ? (
          <p className="key-settings-empty">当前账号暂无可用 key，请前往订阅管理页面设置</p>
        ) : (
          <ul className="key-list">
            {keys.map((masked, i) => (
              <li key={i}>
                <button
                  type="button"
                  className={`key-row ${i === activeIndex ? "active" : ""}`}
                  disabled={busy}
                  onClick={() => i !== activeIndex && onSelect(i)}
                >
                  <span className={`key-check ${i === activeIndex ? "checked" : ""}`} aria-hidden />
                  <span className="key-mask">{masked}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";

type Platform = "xiaohongshu" | "wechat";

interface PreviewPanelProps {
  content: string;
  onClose: () => void;
}

export function PreviewPanel({ content, onClose }: PreviewPanelProps) {
  const [platform, setPlatform] = useState<Platform>("xiaohongshu");

  return (
    <div className="preview-panel">
      <div className="preview-header">
        <span className="preview-title">预览</span>
        <div className="preview-header-right">
          <div className="platform-toggle">
            <button
              className={`platform-btn ${platform === "xiaohongshu" ? "active" : ""}`}
              onClick={() => setPlatform("xiaohongshu")}
            >
              小红书
            </button>
            <button
              className={`platform-btn ${platform === "wechat" ? "active" : ""}`}
              onClick={() => setPlatform("wechat")}
            >
              公众号
            </button>
          </div>
          <button className="preview-close" onClick={onClose} title="关闭预览">
            ✕
          </button>
        </div>
      </div>

      <div className={`preview-card preview-card--${platform}`}>
        <div className="preview-card-content">
          {platform === "xiaohongshu" ? (
            <div className="xhs-card">
              <div className="xhs-image-placeholder" />
              <div className="xhs-text">{content}</div>
            </div>
          ) : (
            <div className="wechat-card">
              <div className="wechat-text">{content}</div>
            </div>
          )}
        </div>
      </div>

      <div className="preview-actions">
        <button className="preview-action-btn" title="编辑" disabled>
          编辑
        </button>
        <button
          className="preview-action-btn"
          title="换平台"
          onClick={() =>
            setPlatform((p) => (p === "xiaohongshu" ? "wechat" : "xiaohongshu"))
          }
        >
          换平台
        </button>
        {/* TODO: wire real publish */}
        <button className="preview-action-btn preview-action-btn--primary" title="发布" disabled>
          发布
        </button>
      </div>
    </div>
  );
}

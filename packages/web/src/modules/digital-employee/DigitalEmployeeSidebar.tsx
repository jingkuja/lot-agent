import { useState } from "react";
import type { Conversation } from "../../api/client.js";

export type DigitalEmployeeFeature = "marketing-materials" | "customer-profile" | "acquisition" | "copy";

interface DigitalEmployeeSidebarProps {
  activeFeature: DigitalEmployeeFeature;
  conversations: Conversation[];
  activeConversationId?: string | null;
  onOpenFeature: (feature: DigitalEmployeeFeature) => void;
  onOpenConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation?: (id: string) => void;
  loadingMore?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

const DIGITAL_EMPLOYEE_GROUPS: Array<{
  id: string;
  label: string;
  features: Array<{
    id: DigitalEmployeeFeature;
    label: string;
    description: string;
    icon: string;
  }>;
}> = [
  {
    id: "marketing",
    label: "营销 Agent",
    features: [
      { id: "marketing-materials", label: "营销资料", description: "单客与客群共用事实库", icon: "◆" },
      { id: "customer-profile", label: "客户画像", description: "记录客户事实与动态", icon: "◎" },
      { id: "acquisition", label: "商机雷达", description: "扫描客户动态，发现跟进先机", icon: "◇" },
      { id: "copy", label: "获客宝", description: "客群洞察与营销内容", icon: "✎" },
    ],
  },
];

/** Independent digital-employee navigation. Agent Center never renders these items. */
export function DigitalEmployeeSidebar({
  activeFeature,
  conversations,
  activeConversationId,
  onOpenFeature,
  onOpenConversation,
  onNewConversation,
  onDeleteConversation,
  loadingMore = false,
  hasMore = false,
  onLoadMore,
}: DigitalEmployeeSidebarProps) {
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="de-module-sidebar">
      <nav className="de-module-groups" aria-label="数字员工能力">
        {DIGITAL_EMPLOYEE_GROUPS.map((group) => (
          <section key={group.id} className="de-module-group">
            <h2>{group.label}</h2>
            <div className="de-module-feature-list">
              {group.features.map((feature) => (
                <button
                  key={feature.id}
                  className={`de-module-feature ${activeFeature === feature.id ? "active" : ""}`}
                  onClick={() => onOpenFeature(feature.id)}
                >
                  <span className="de-module-feature-icon" aria-hidden>{feature.icon}</span>
                  <span>
                    <strong>{feature.label}</strong>
                    <small>{feature.description}</small>
                  </span>
                  <span className="de-module-feature-arrow" aria-hidden>›</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </nav>

      <div className="de-history-anchor">
        <button
          className={`de-history-trigger ${historyOpen ? "active" : ""}`}
          onClick={() => setHistoryOpen((open) => !open)}
          aria-expanded={historyOpen}
        >
          <span aria-hidden>◷</span>
          历史对话
          {conversations.length > 0 && <b>{conversations.length}</b>}
        </button>

        {historyOpen && (
          <div className="de-history-popover" role="dialog" aria-label="数字员工历史对话">
            <header>
              <div>
                <strong>历史对话</strong>
                <small>仅显示数字员工会话</small>
              </div>
              <button onClick={() => setHistoryOpen(false)} aria-label="关闭">×</button>
            </header>
            <button
              className="de-history-new"
              onClick={() => {
                onNewConversation();
                setHistoryOpen(false);
              }}
            >
              <span aria-hidden>＋</span> 新对话
            </button>
            <div className="de-history-list">
              {conversations.length === 0 && <p>暂无数字员工对话</p>}
              {conversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`de-history-item ${conversation.id === activeConversationId ? "active" : ""}`}
                >
                  <button
                    className="de-history-open"
                    onClick={() => {
                      onOpenConversation(conversation.id);
                      setHistoryOpen(false);
                    }}
                  >
                    {conversation.title || "新对话"}
                  </button>
                  {onDeleteConversation && (
                    <button
                      className="de-history-delete"
                      aria-label="删除对话"
                      onClick={() => onDeleteConversation(conversation.id)}
                    >×</button>
                  )}
                </div>
              ))}
              {loadingMore && <p>加载中…</p>}
            </div>
            {hasMore && onLoadMore && (
              <button className="de-history-more" disabled={loadingMore} onClick={onLoadMore}>加载更多</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

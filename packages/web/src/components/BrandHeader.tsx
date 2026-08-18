import type { User } from "../api/client.js";

interface BrandHeaderProps {
  user?: User;
  onLogout?: () => void;
  onOpenKeySettings?: () => void;
  onCollapse: () => void;
  onOpenAgentCenter?: () => void;
  onOpenAssistant?: () => void;
  onOpenDigitalEmployee?: () => void;
  onOpenKnowledgeBase?: () => void;
  activeModule?: "assistant" | "digitalEmployee";
}

/** Top-left brand card: cloud logo + product name + tagline, a collapse
 *  toggle, and the account block (username on top, 退出 on its own line).
 *  The new-chat button lives in the sidebar's 最近对话 header. */
export function BrandHeader({
  user,
  onLogout,
  onOpenKeySettings,
  onCollapse,
  onOpenAgentCenter,
  onOpenAssistant,
  onOpenDigitalEmployee,
  onOpenKnowledgeBase,
  activeModule = "assistant",
}: BrandHeaderProps) {
  return (
    <div className="brand-header">
      <div className="brand-card">
        <span className="brand-logo" aria-hidden>
          <img
            src="data:image/png;base64,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"
            alt=""
          />
        </span>

        <div className="brand-meta">
          <span className="brand-title">灵渠claw</span>
          <span className="brand-subtitle">借势智算</span>
        </div>

        <button
          className="brand-collapse"
          onClick={onCollapse}
          title="收起侧栏"
          aria-label="收起侧栏"
        >
          ‹
        </button>
      </div>

      <div className="brand-actions">
        <div className="brand-account">
          {user && (
            <span className="brand-email" title={user.name ?? user.username ?? ""}>
              {user.name ?? user.username ?? ""}
            </span>
          )}
          {user && onLogout && (
            <button className="btn-logout" onClick={onLogout}>
              退出
            </button>
          )}
        </div>
      </div>

      {(onOpenKeySettings || onOpenAgentCenter || onOpenKnowledgeBase || onOpenAssistant || onOpenDigitalEmployee) && (
        <div className="brand-navigation-actions">
          {(onOpenKeySettings || onOpenAgentCenter) && (
            <div className="brand-quick-actions">
              {onOpenKeySettings && (
                <button className="brand-quick-action" onClick={onOpenKeySettings} title="API-Key 选择">
                  <span className="brand-action-icon" aria-hidden>
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="8" cy="15" r="3" />
                      <path d="m10.2 12.8 7.3-7.3M15 8l2 2M17.5 5.5l1 1" />
                    </svg>
                  </span>
                  <span>API-Key 选择</span>
                </button>
              )}
              {onOpenAgentCenter && (
                <button className="brand-quick-action" onClick={onOpenAgentCenter} title="Agent 管理">
                  <span className="brand-action-icon" aria-hidden>
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7" rx="1.5" />
                      <rect x="14" y="3" width="7" height="7" rx="1.5" />
                      <rect x="3" y="14" width="7" height="7" rx="1.5" />
                      <path d="M17.5 14v7M14 17.5h7" />
                    </svg>
                  </span>
                  <span>Agent 管理</span>
                </button>
              )}
            </div>
          )}
          {onOpenKnowledgeBase && (
            <button className="brand-knowledge-btn" onClick={onOpenKnowledgeBase} title="个人知识库">
              <span className="brand-action-icon brand-knowledge-icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <ellipse cx="12" cy="5" rx="7" ry="3" />
                  <path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
                  <path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
                </svg>
              </span>
              <span className="brand-knowledge-copy">
                <strong>个人知识库</strong>
                <small>沉淀资料与专属知识</small>
              </span>
              <span className="brand-link-arrow" aria-hidden>↗</span>
            </button>
          )}
          {(onOpenAssistant || onOpenDigitalEmployee) && (
            <div className="brand-module-switch" role="tablist" aria-label="工作区导航">
              <button
                type="button"
                role="tab"
                aria-selected={activeModule === "assistant"}
                className={`brand-module-tab ${activeModule === "assistant" ? "active" : ""}`}
                onClick={onOpenAssistant}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 19V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12" />
                  <path d="M8 9h3v3H8zM14 9h2M14 12h2M8 16h8" />
                </svg>
                AI Studio
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeModule === "digitalEmployee"}
                className={`brand-module-tab ${activeModule === "digitalEmployee" ? "active" : ""}`}
                onClick={onOpenDigitalEmployee}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="8" r="3.5" />
                  <path d="M5.5 20c.7-4 2.9-6 6.5-6s5.8 2 6.5 6" />
                  <path d="M18.5 5.5h2M19.5 4.5v2" />
                </svg>
                数字员工
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

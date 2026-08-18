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
          <svg viewBox="0 0 48 48" width="38" height="38">
            <defs>
              <linearGradient id="brandCloud" x1="6" y1="14" x2="42" y2="38" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#3b82f6" />
                <stop offset="1" stopColor="#22d3ee" />
              </linearGradient>
            </defs>
            <circle cx="24" cy="24" r="22.5" fill="#ffffff" stroke="#dbe3f0" />
            <g fill="url(#brandCloud)">
              <circle cx="19" cy="27" r="7.5" />
              <circle cx="29" cy="23" r="9.5" />
              <circle cx="34" cy="29" r="6" />
              <rect x="16" y="27" width="20" height="9" rx="4.5" />
            </g>
            <text
              x="25"
              y="31"
              textAnchor="middle"
              fontSize="16"
              fontWeight="800"
              fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
              fill="#ffffff"
            >
              A
            </text>
          </svg>
        </span>

        <div className="brand-meta">
          <span className="brand-title">借势智算</span>
          <span className="brand-subtitle">AI盒子智能体</span>
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
                <button className="brand-quick-action" onClick={onOpenKeySettings} title="API-Key 设置">
                  <span className="brand-action-icon" aria-hidden>
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="8" cy="15" r="3" />
                      <path d="m10.2 12.8 7.3-7.3M15 8l2 2M17.5 5.5l1 1" />
                    </svg>
                  </span>
                  <span>API-Key 设置</span>
                </button>
              )}
              {onOpenAgentCenter && (
                <button className="brand-quick-action" onClick={onOpenAgentCenter} title="Agent 中心">
                  <span className="brand-action-icon" aria-hidden>
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7" rx="1.5" />
                      <rect x="14" y="3" width="7" height="7" rx="1.5" />
                      <rect x="3" y="14" width="7" height="7" rx="1.5" />
                      <path d="M17.5 14v7M14 17.5h7" />
                    </svg>
                  </span>
                  <span>Agent 中心</span>
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
                Agent 广场
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

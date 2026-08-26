import { BRAND_LOGO_SRC } from "../assets/brand-logo.js";
import type { User } from "../api/client.js";
import { AccountMenu } from "./AccountMenu.js";
import { PointsBalance } from "./PointsBalance.js";

interface BrandHeaderProps {
  user?: User;
  onLogout?: () => void;
  onCollapse: () => void;
  onOpenAgentCenter?: () => void;
  onOpenAssistant?: () => void;
  onOpenDigitalEmployee?: () => void;
  onOpenKnowledgeBase?: () => void;
  activeModule?: "assistant" | "digitalEmployee";
}

/** Top-left identity strip: logo, product name, account, and workspace nav.
 *  The new-chat button lives in the sidebar's 历史对话 header. */
export function BrandHeader({
  user,
  onLogout,
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
            src={BRAND_LOGO_SRC}
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
        {user && <AccountMenu user={user} onLogout={onLogout} />}
      </div>

      {(onOpenAgentCenter || onOpenKnowledgeBase || onOpenAssistant || onOpenDigitalEmployee) && (
        <div className="brand-navigation-actions">
          {user && <PointsBalance />}
          {(onOpenAgentCenter || onOpenKnowledgeBase) && (
            <div className="brand-quick-actions">
              {onOpenAgentCenter && (
                <button className="brand-quick-action" onClick={onOpenAgentCenter} title="Studio 管理">
                  <span className="brand-action-icon" aria-hidden>
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7" rx="1.5" />
                      <rect x="14" y="3" width="7" height="7" rx="1.5" />
                      <rect x="3" y="14" width="7" height="7" rx="1.5" />
                      <path d="M17.5 14v7M14 17.5h7" />
                    </svg>
                  </span>
                  <span>Studio 管理</span>
                </button>
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
                </button>
              )}
            </div>
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

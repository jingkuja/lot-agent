import { useI18n } from "../i18n/index.js";
import { LanguageSelect } from "../i18n/index.js";
import { BRAND_LOGO_SRC } from "../assets/brand-logo.js";
import type { User } from "../api/client.js";
import { AccountMenu } from "./AccountMenu.js";
import { PointsBalance } from "./PointsBalance.js";

interface BrandHeaderProps {
  user?: User;
  onLogout?: () => void;
  onCollapse: () => void;
  onOpenDigitalTwin?: () => void;
  onOpenAssistant?: () => void;
  onOpenDigitalEmployee?: () => void;
  onOpenKnowledgeBase?: () => void;
  activeModule?: "assistant" | "digitalEmployee";
  balanceRefreshKey?: number;
}

/** Top-left identity strip: logo, product name, account, and workspace nav.
 *  The new-chat button lives in the sidebar's 历史对话 header. */
export function BrandHeader({
  user,
  onLogout,
  onCollapse,
  onOpenDigitalTwin,
  onOpenAssistant,
  onOpenDigitalEmployee,
  onOpenKnowledgeBase,
  activeModule = "assistant",
  balanceRefreshKey,
}: BrandHeaderProps) {
  const { t } = useI18n();
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
          <span className="brand-title">{t("灵渠claw")}</span>
          <span className="brand-subtitle">{t("借势智算")}</span>
        </div>

        <LanguageSelect />
        <button
          className="brand-collapse"
          onClick={onCollapse}
          title={t("收起侧栏")}
          aria-label={t("收起侧栏")}
        >
          ‹
        </button>
      </div>

      <div className="brand-actions">
        {user && <AccountMenu user={user} onLogout={onLogout} />}
      </div>

      {(onOpenDigitalTwin || onOpenKnowledgeBase || onOpenAssistant || onOpenDigitalEmployee) && (
        <div className="brand-navigation-actions">
          {user && <PointsBalance refreshKey={balanceRefreshKey} />}
          {(onOpenDigitalTwin || onOpenKnowledgeBase) && (
            <div className="brand-quick-actions">
              {onOpenDigitalTwin && (
                <button className="brand-quick-action" onClick={onOpenDigitalTwin} title={t("数字分身")}>
                  <span className="brand-action-icon" aria-hidden>
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="8" r="4" />
                      <path d="M5 21v-2a7 7 0 0 1 14 0v2M3 6V3h3M18 3h3v3" />
                    </svg>
                  </span>
                  <span>{t("数字分身")}</span>
                </button>
              )}
              {onOpenKnowledgeBase && (
                <button className="brand-knowledge-btn" onClick={onOpenKnowledgeBase} title={t("个人知识库")}>
                  <span className="brand-action-icon brand-knowledge-icon" aria-hidden>
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <ellipse cx="12" cy="5" rx="7" ry="3" />
                      <path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
                      <path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
                    </svg>
                  </span>
                  <span className="brand-knowledge-copy">
                    <strong>{t("个人知识库")}</strong>
                    <small>{t("沉淀资料与专属知识")}</small>
                  </span>
                </button>
              )}
            </div>
          )}
          {(onOpenAssistant || onOpenDigitalEmployee) && (
            <div className="brand-module-switch" role="tablist" aria-label={t("工作区导航")}>
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
                {t("数字员工")}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

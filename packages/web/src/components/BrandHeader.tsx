import type { User } from "../api/client.js";

interface BrandHeaderProps {
  user?: User;
  onLogout?: () => void;
  onCreate: () => void;
  onCollapse: () => void;
}

/** Top-left brand card: cloud logo + product name + tagline, a collapse
 *  toggle, and a single action row (account + new-chat) — replaces both the
 *  old footer status bar and the sidebar's "对话" header row. */
export function BrandHeader({ user, onLogout, onCreate, onCollapse }: BrandHeaderProps) {
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
          <span className="brand-title">智算AI</span>
          <span className="brand-subtitle">万能智能体</span>
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
            <span className="brand-email" title={user.email}>
              {user.email}
            </span>
          )}
          {user && onLogout && (
            <button className="btn-logout" onClick={onLogout}>
              退出
            </button>
          )}
        </div>
        <button className="btn-new" onClick={onCreate} title="新建对话">
          +
        </button>
      </div>
    </div>
  );
}

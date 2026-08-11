import { useState } from "react";
import { api, setToken, type User } from "../api/client.js";
import { encryptPassword } from "../lib/rsa.js";
import { ServerSettingsModal } from "./ServerSettingsModal.js";

interface LoginProps {
  onLogin: (user: User) => void;
  /** Message to show on first render, e.g. after a failed `?token=` auto-login. */
  initialError?: string | null;
}

const LOGIN_FAIL = "登录失败，请稍后再试或者联系管理员";

export function Login({ onLogin, initialError = null }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  // Desktop shell: server endpoint is configurable via the bridge.
  const desktop = typeof window !== "undefined" ? window.lotDesktop : undefined;
  const [serverModalOpen, setServerModalOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState<string | null>(() =>
    desktop ? desktop.getServerUrl() : null
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setError(null);
    setLoading(true);
    try {
      const { publicKey } = await api.getPublicKey();
      const encrypted = await encryptPassword(publicKey, password);
      const res = await api.login(username.trim(), encrypted);
      setToken(res.token);
      onLogin(res.user);
    } catch (err) {
      setError(
        err instanceof Error && err.message !== "Unauthorized" ? err.message : LOGIN_FAIL
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <section className="login-showcase" aria-label="借势智算产品介绍">
        <div className="login-showcase-glow login-showcase-glow-one" aria-hidden />
        <div className="login-showcase-glow login-showcase-glow-two" aria-hidden />
        <div className="login-showcase-grid" aria-hidden />

        <div className="login-brand">
          <span className="login-brand-mark" aria-hidden>
            <svg viewBox="0 0 48 48" width="28" height="28">
              <defs>
                <linearGradient id="loginCloud" x1="7" y1="10" x2="42" y2="39" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="currentColor" stopOpacity="0.82" />
                  <stop offset="1" stopColor="currentColor" />
                </linearGradient>
              </defs>
              <g fill="url(#loginCloud)">
                <circle cx="18" cy="27" r="7" />
                <circle cx="28" cy="22" r="9" />
                <circle cx="34" cy="29" r="5.5" />
                <rect x="15" y="27" width="21" height="8" rx="4" />
              </g>
              <path d="M20 28.5h8M24 24.5v8" stroke="var(--login-hero)" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </span>
          <span>借势智算</span>
        </div>

        <div className="login-showcase-content">
          <p className="login-eyebrow"><span /> AI 原生工作空间</p>
          <h1>让每一个想法<br />都有一支 <em>AI 团队</em></h1>
          <p className="login-showcase-copy">
            汇集创作、图像、视频与办公智能体，让复杂工作在一个流畅的工作空间里完成。
          </p>

          <div className="login-agent-stage" aria-label="多智能体能力展示">
            <div className="login-orbit login-orbit-large" aria-hidden />
            <div className="login-orbit login-orbit-small" aria-hidden />
            <div className="login-agent-core"><span>AI</span><small>协作中</small></div>
            <div className="login-agent-pill login-agent-pill-copy"><span>✦</span> 文案创作</div>
            <div className="login-agent-pill login-agent-pill-image"><span>◈</span> 图片生成</div>
            <div className="login-agent-pill login-agent-pill-ppt"><span>▤</span> PPT 制作</div>
            <div className="login-agent-pill login-agent-pill-video"><span>▷</span> 视频生成</div>
          </div>

          <div className="login-showcase-points">
            <span><i>01</i> 多模型，按需调用</span>
            <span><i>02</i> 多智能体，协同交付</span>
          </div>
        </div>

        <p className="login-showcase-note">借势而为 · 智算未来</p>
      </section>

      <section className="login-access">
        <div className="login-mobile-brand" aria-label="借势智算">
          <span aria-hidden>✦</span>
          借势智算
        </div>
        <div className="login-card">
          <div className="login-card-heading">
            <p className="login-card-kicker">WELCOME BACK</p>
            <h2>欢迎回来</h2>
            <p>登录后继续你的智能工作流</p>
          </div>
          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-field">
              <label htmlFor="login-username">用户名</label>
              <input
                id="login-username"
                type="text"
                placeholder="请输入手机号或账号"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
                disabled={loading}
              />
            </div>
            <div className="login-field">
              <label htmlFor="login-password">密码</label>
              <input
                id="login-password"
                type="password"
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
              />
            </div>
            {error && <p className="login-error">{error}</p>}
            <button
              type="submit"
              className="login-btn"
              disabled={loading || !username.trim() || !password}
            >
              {loading ? "正在进入..." : "进入工作空间"}
              {!loading && <span aria-hidden>→</span>}
            </button>
          </form>
          {desktop && (
            <button
              type="button"
              className="login-server-link"
              onClick={() => setServerModalOpen(true)}
            >
              服务器设置{serverUrl ? ` · ${serverUrl}` : ""}
            </button>
          )}
        </div>
        <p className="login-access-tip"><span>✦</span> 使用你的专属 API Key，数据和用量清晰可控</p>
      </section>

      <footer className="login-compliance" aria-label="网站备案与许可信息">
        <a
          href="https://beian.miit.gov.cn/"
          target="_blank"
          rel="noreferrer"
        >
          蜀ICP备2025156360号-2
        </a>
        <span>增值电信业务经营许可证：川B2-20260779</span>
      </footer>
      {serverModalOpen && desktop && (
        <ServerSettingsModal
          onClose={() => {
            setServerModalOpen(false);
            // Refresh the displayed url after a successful save.
            setServerUrl(desktop.getServerUrl());
          }}
        />
      )}
    </div>
  );
}

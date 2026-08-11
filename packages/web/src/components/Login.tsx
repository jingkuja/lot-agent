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
      <div className="login-card">
        <h1 className="login-title">借势智算</h1>
        <p className="login-subtitle">AI 大模型聚合平台</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="login-username">用户名</label>
            <input
              id="login-username"
              type="text"
              placeholder="用户名（手机号或账号）"
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
              placeholder="密码"
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
            {loading ? "登录中..." : "进入"}
          </button>
        </form>
        {desktop && (
          <button
            type="button"
            className="login-server-link"
            onClick={() => setServerModalOpen(true)}
          >
            服务器设置{serverUrl ? `（${serverUrl}）` : ""}
          </button>
        )}
      </div>
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

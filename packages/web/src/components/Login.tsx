import { useEffect, useRef, useState } from "react";
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
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loginMethod, setLoginMethod] = useState<"password" | "phone">("password");
  const [bindEmail, setBindEmail] = useState(false);
  const [bindPhone, setBindPhone] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const registrationRequestId = useRef(crypto.randomUUID());
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState<"email" | "phone" | null>(null);
  const [emailCountdown, setEmailCountdown] = useState(0);
  const [phoneCountdown, setPhoneCountdown] = useState(0);
  // Desktop shell: server endpoint is configurable via the bridge.
  const desktop = typeof window !== "undefined" ? window.lotDesktop : undefined;
  const [serverModalOpen, setServerModalOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState<string | null>(() =>
    desktop ? desktop.getServerUrl() : null
  );

  useEffect(() => {
    void api.mode()
      .then((result) => setRegistrationEnabled(result.managedRegistration === true))
      .catch(() => setRegistrationEnabled(false));
  }, []);

  useEffect(() => {
    if (emailCountdown <= 0 && phoneCountdown <= 0) return;
    const timer = window.setInterval(() => {
      setEmailCountdown((value) => Math.max(0, value - 1));
      setPhoneCountdown((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [emailCountdown > 0, phoneCountdown > 0]);

  const sendEmailCode = async () => {
    if (!email.trim()) {
      setError("请先填写邮箱地址");
      return;
    }
    setError(null);
    setNotice(null);
    setSendingCode("email");
    try {
      const result = await api.sendEmailVerification(email.trim());
      setEmailCountdown(result.resendAfter || 60);
      setNotice("邮箱验证码已发送，请注意查收");
    } catch (err) {
      setError(err instanceof Error ? err.message : "邮箱验证码发送失败");
    } finally {
      setSendingCode(null);
    }
  };

  const sendPhoneCode = async () => {
    if (!phone.trim()) {
      setError("请先填写手机号");
      return;
    }
    setError(null);
    setNotice(null);
    setSendingCode("phone");
    try {
      const result = await api.sendPhoneVerification(phone.trim(), mode === "register" ? "register" : "login");
      setPhoneCountdown(result.resendAfter || 60);
      setNotice("手机验证码已发送，请注意查收");
    } catch (err) {
      setError(err instanceof Error ? err.message : "手机验证码发送失败");
    } finally {
      setSendingCode(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "login" && loginMethod === "phone") {
      if (!phone.trim() || !phoneCode.trim()) return;
    } else if (!username.trim() || !password) {
      return;
    }
    if (mode === "register" && password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    if (mode === "register" && bindEmail && (!email.trim() || !emailCode.trim())) {
      setError("请填写邮箱并输入邮箱验证码");
      return;
    }
    if (mode === "register" && bindPhone && (!phone.trim() || !phoneCode.trim())) {
      setError("请填写手机号并输入手机验证码");
      return;
    }
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      let res: Awaited<ReturnType<typeof api.login>>;
      if (mode === "login" && loginMethod === "phone") {
        res = await api.phoneLogin(phone.trim(), phoneCode.trim());
      } else {
        const { publicKey } = await api.getPublicKey();
        const encrypted = await encryptPassword(publicKey, password);
        res = mode === "register"
          ? await api.register({
              username: username.trim(),
              encryptedPassword: encrypted,
              email: bindEmail ? email.trim() : undefined,
              emailVerificationCode: bindEmail ? emailCode.trim() : undefined,
              phone: bindPhone ? phone.trim() : undefined,
              phoneVerificationCode: bindPhone ? phoneCode.trim() : undefined,
              requestId: registrationRequestId.current,
            })
          : await api.login(username.trim(), encrypted);
      }
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

  const submitDisabled = loading || sendingCode !== null || (
    mode === "register"
      ? !username.trim() || !password || !confirmPassword
        || (bindEmail && (!email.trim() || !emailCode.trim()))
        || (bindPhone && (!phone.trim() || !phoneCode.trim()))
      : loginMethod === "password"
        ? !username.trim() || !password
        : !phone.trim() || !phoneCode.trim()
  );

  return (
    <div className={`login-page login-page-${mode}`}>
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
            <p className="login-card-kicker">{mode === "login" ? "WELCOME BACK" : "CREATE ACCOUNT"}</p>
            <h2>{mode === "login" ? "欢迎回来" : "创建账号"}</h2>
            <p>{mode === "login" ? "登录后继续你的智能工作流" : "注册后即可使用托管 AI 订阅"}</p>
          </div>
          <form className="login-form" onSubmit={handleSubmit}>
            {mode === "login" && registrationEnabled && (
              <div className="login-method-tabs" role="tablist" aria-label="登录方式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={loginMethod === "password"}
                  className={loginMethod === "password" ? "active" : ""}
                  onClick={() => { setLoginMethod("password"); setError(null); setNotice(null); }}
                  disabled={loading}
                >用户名密码</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={loginMethod === "phone"}
                  className={loginMethod === "phone" ? "active" : ""}
                  onClick={() => { setLoginMethod("phone"); setError(null); setNotice(null); }}
                  disabled={loading}
                >手机号验证码</button>
              </div>
            )}

            {(mode === "register" || loginMethod === "password") && (
              <div className="login-field">
                <label htmlFor="login-username">用户名</label>
                <input
                  id="login-username"
                  type="text"
                  placeholder="请输入用户名"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoFocus
                  autoComplete="username"
                  disabled={loading}
                />
              </div>
            )}

            {mode === "register" && (
              <div className="login-bindings">
                <label className="login-checkbox">
                  <input
                    type="checkbox"
                    checked={bindEmail}
                    onChange={(e) => { setBindEmail(e.target.checked); setError(null); setNotice(null); }}
                    disabled={loading}
                  />
                  <span>绑定邮箱</span>
                </label>
                <label className="login-checkbox">
                  <input
                    type="checkbox"
                    checked={bindPhone}
                    onChange={(e) => { setBindPhone(e.target.checked); setError(null); setNotice(null); }}
                    disabled={loading}
                  />
                  <span>绑定手机号</span>
                </label>
              </div>
            )}

            {mode === "register" && bindEmail && (
              <div className="login-verification-group">
                <div className="login-field">
                  <label htmlFor="register-email">邮箱</label>
                  <div className="login-code-row">
                    <input
                      id="register-email"
                      type="email"
                      placeholder="请输入邮箱地址"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      autoComplete="email"
                      disabled={loading}
                    />
                    <button type="button" onClick={sendEmailCode} disabled={loading || sendingCode !== null || emailCountdown > 0 || !email.trim()}>
                      {sendingCode === "email" ? "发送中..." : emailCountdown > 0 ? `${emailCountdown}s` : "发送验证码"}
                    </button>
                  </div>
                </div>
                <div className="login-field">
                  <label htmlFor="register-email-code">邮箱验证码</label>
                  <input id="register-email-code" inputMode="numeric" maxLength={6} placeholder="请输入 6 位验证码" value={emailCode} onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ""))} required disabled={loading} />
                </div>
              </div>
            )}

            {((mode === "register" && bindPhone) || (mode === "login" && loginMethod === "phone")) && (
              <div className="login-verification-group">
                <div className="login-field">
                  <label htmlFor="login-phone">手机号</label>
                  <div className="login-code-row">
                    <input id="login-phone" type="tel" inputMode="tel" placeholder="请输入中国大陆手机号" value={phone} onChange={(e) => setPhone(e.target.value)} required autoFocus={mode === "login"} autoComplete="tel" disabled={loading} />
                    <button type="button" onClick={sendPhoneCode} disabled={loading || sendingCode !== null || phoneCountdown > 0 || !phone.trim()}>
                      {sendingCode === "phone" ? "发送中..." : phoneCountdown > 0 ? `${phoneCountdown}s` : "发送验证码"}
                    </button>
                  </div>
                </div>
                <div className="login-field">
                  <label htmlFor="login-phone-code">手机验证码</label>
                  <input id="login-phone-code" inputMode="numeric" maxLength={6} placeholder="请输入 6 位验证码" value={phoneCode} onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, ""))} required autoComplete="one-time-code" disabled={loading} />
                </div>
              </div>
            )}

            {(mode === "register" || loginMethod === "password") && (
              <div className="login-field">
                <label htmlFor="login-password">密码</label>
                <input id="login-password" type="password" placeholder="请输入密码" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={mode === "register" ? "new-password" : "current-password"} disabled={loading} />
              </div>
            )}
            {mode === "register" && (
              <div className="login-field">
                <label htmlFor="register-confirm-password">确认密码</label>
                <input id="register-confirm-password" type="password" placeholder="请再次输入密码" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required autoComplete="new-password" disabled={loading} />
              </div>
            )}
            {error && <p className="login-error">{error}</p>}
            {notice && <p className="login-notice">{notice}</p>}
            <button
              type="submit"
              className="login-btn"
              disabled={submitDisabled}
            >
              {loading ? (mode === "login" ? "正在进入..." : "正在创建...") : (mode === "login" ? "进入工作空间" : "创建并进入")}
              {!loading && <span aria-hidden>→</span>}
            </button>
          </form>
          {(registrationEnabled || mode === "register") && (
            <button
              type="button"
              className="login-mode-switch"
              disabled={loading}
              onClick={() => {
                setMode((current) => current === "login" ? "register" : "login");
                setError(null);
              }}
            >
              {mode === "login" ? "没有账号？立即注册" : "已有账号？返回登录"}
            </button>
          )}
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
      </section>
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

import { useI18n } from "../i18n/index.js";
import { LanguageSelect } from "../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { api, setToken, type User } from "../api/client.js";
import { encryptPassword } from "../lib/rsa.js";
import { LegalModal } from "./LegalModal.js";
import { PasswordReset } from "./PasswordReset.js";
import { LandscapeBackdrop } from "./LandscapeBackdrop.js";
import { BRAND_LOGO_SRC } from "../assets/brand-logo.js";

interface LoginProps {
  onLogin: (user: User) => void;
  /** Message to show on first render, e.g. after a failed `?token=` auto-login. */
  initialError?: string | null;
}

const LOGIN_FAIL = "登录失败，请稍后再试或者联系管理员";

type LoginScreen = "login" | "register" | "forgot" | "reset";

function initialLoginScreen(): LoginScreen {
  if (typeof window === "undefined") return "login";
  const params = new URLSearchParams(window.location.search);
  return window.location.pathname === "/reset-password" && params.get("reset_token") ? "reset" : "login";
}

export function Login({ onLogin, initialError = null }: LoginProps) {
  const { t, enabled: international, showCompliance } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [screen, setScreen] = useState<LoginScreen>(initialLoginScreen);
  const [loginMethod, setLoginMethod] = useState<"password" | "phone">("password");
  const [bindPhone, setBindPhone] = useState(false);
  const phoneEnabled = !international;
  const effectiveLoginMethod = phoneEnabled ? loginMethod : "password";
  const shouldBindPhone = phoneEnabled && bindPhone;
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const registrationRequestId = useRef(crypto.randomUUID());
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState<"email" | "phone" | null>(null);
  const [emailCountdown, setEmailCountdown] = useState(0);
  const [phoneCountdown, setPhoneCountdown] = useState(0);
  const [legalDialog, setLegalDialog] = useState<"terms" | "privacy" | null>(null);

  const resetParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const resetEmail = resetParams?.get("email") ?? "";
  const resetToken = resetParams?.get("reset_token") ?? "";

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
    if (!phoneEnabled) return;
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
    if (mode === "login" && effectiveLoginMethod === "phone") {
      if (!phone.trim() || !phoneCode.trim()) return;
    } else if (!username.trim() || !password) {
      return;
    }
    if (mode === "register" && password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    if (mode === "register" && (!email.trim() || !emailCode.trim())) {
      setError("请填写邮箱并输入邮箱验证码");
      return;
    }
    if (mode === "register" && shouldBindPhone && (!phone.trim() || !phoneCode.trim())) {
      setError("请填写手机号并输入手机验证码");
      return;
    }
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      let res: Awaited<ReturnType<typeof api.login>>;
      if (mode === "login" && effectiveLoginMethod === "phone") {
        res = await api.phoneLogin(phone.trim(), phoneCode.trim());
      } else {
        const { publicKey } = await api.getPublicKey();
        const encrypted = await encryptPassword(publicKey, password);
        res = mode === "register"
          ? await api.register({
              username: username.trim(),
              encryptedPassword: encrypted,
              email: email.trim(),
              emailVerificationCode: emailCode.trim(),
              phone: shouldBindPhone ? phone.trim() : undefined,
              phoneVerificationCode: shouldBindPhone ? phoneCode.trim() : undefined,
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
        || !email.trim() || !emailCode.trim()
        || (shouldBindPhone && (!phone.trim() || !phoneCode.trim()))
      : effectiveLoginMethod === "password"
        ? !username.trim() || !password
        : !phone.trim() || !phoneCode.trim()
  );

  if (screen === "forgot" || screen === "reset") {
    return (
      <PasswordReset
        key={screen}
        initialMode={screen === "reset" ? "confirm" : "request"}
        initialEmail={screen === "reset" ? resetEmail : email}
        token={resetToken}
        onBack={() => {
          window.history.replaceState({}, "", "/");
          setScreen("login");
          setError(null);
          setNotice(null);
        }}
      />
    );
  }

  return (
    <div className={`login-page login-page-${mode}`}>
      <section className="login-showcase" aria-label={t("万象灵工产品介绍")}>
        <div className="login-ai-canvas" aria-hidden="true">
          <div className="login-ai-grid" />
          <div className="login-ai-aurora login-ai-aurora-a" />
          <div className="login-ai-aurora login-ai-aurora-b" />
          <svg className="login-ai-network" viewBox="0 0 520 520" fill="none">
            <defs>
              <linearGradient id="loginAiOrbit" x1="60" y1="40" x2="460" y2="460" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.65" />
                <stop offset="52%" stopColor="var(--accent-2)" stopOpacity="0.45" />
                <stop offset="100%" stopColor="var(--gold)" stopOpacity="0.35" />
              </linearGradient>
              <radialGradient id="loginAiCoreGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.42" />
                <stop offset="55%" stopColor="var(--accent-2)" stopOpacity="0.14" />
                <stop offset="100%" stopColor="var(--accent-2)" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="330" cy="186" r="168" fill="url(#loginAiCoreGlow)" />
            <circle cx="330" cy="186" r="154" stroke="url(#loginAiOrbit)" strokeWidth="1" strokeDasharray="4 8" />
            <circle cx="330" cy="186" r="106" stroke="url(#loginAiOrbit)" strokeWidth="1.1" strokeOpacity="0.7" />
            <circle cx="330" cy="186" r="56" stroke="var(--accent)" strokeWidth="1.2" strokeOpacity="0.55" />
            <path
              d="M176 186L274 186M330 32L330 130M386 186L484 186M221 77L290 146M439 77L370 146M221 295L290 226M439 295L370 226"
              stroke="url(#loginAiOrbit)"
              strokeWidth="1"
              strokeOpacity="0.5"
            />
            <path
              d="M330 162L336 180L354 186L336 192L330 210L324 192L306 186L324 180Z"
              fill="var(--accent)"
              fillOpacity="0.88"
            />
            <circle className="login-ai-node" cx="221" cy="77" r="4.5" fill="var(--accent)" />
            <circle className="login-ai-node login-ai-node-delay" cx="439" cy="77" r="4" fill="var(--accent-2)" />
            <circle className="login-ai-node login-ai-node-slow" cx="439" cy="295" r="5" fill="var(--gold)" />
            <circle className="login-ai-node" cx="221" cy="295" r="4" fill="var(--accent-2)" />
            <circle cx="176" cy="186" r="3" fill="var(--login-hero-text)" fillOpacity="0.7" />
            <circle cx="484" cy="186" r="3" fill="var(--login-hero-text)" fillOpacity="0.6" />
            <circle cx="330" cy="32" r="3.5" fill="var(--accent)" fillOpacity="0.85" />
          </svg>
        </div>
        <LandscapeBackdrop className="login-landscape" />

        <div className="login-brand">
          <span className="login-brand-mark" aria-hidden="true">
            <img src={BRAND_LOGO_SRC} alt="" />
          </span>
          <span className="login-brand-name">{t("万象灵工")}</span>
        </div>

        <div className="login-showcase-content">
          <div className="login-ai-badge">
            <span className="login-ai-badge-dot" aria-hidden="true" />
            <span>{t("多模态 AI 智能体中枢")}</span>
          </div>

          <h1>
            {t("让每一个想法")}
            <br />
            {t("都有一支")} <span className="login-headline-accent">{t("AI 团队")}</span>
          </h1>
          <p className="login-showcase-copy">
            {t("汇集创作、图像、视频与办公智能体，让复杂工作在一个流畅的工作空间里完成。")}
          </p>

          <ul className="login-agents" aria-label={t("多智能体能力展示")}>
            <li className="login-agent-card">
              <span className="login-agent-icon login-agent-icon-general" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3l1.8 4.6L18.5 9.4l-4.7 1.8L12 16l-1.8-4.8L5.5 9.4l4.7-1.8z" />
                  <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
                </svg>
              </span>
              <div className="login-agent-meta">
                <strong>{t("文案创作")}</strong>
                <span>{t("灵感企划与多风格成稿")}</span>
              </div>
            </li>
            <li className="login-agent-card">
              <span className="login-agent-icon login-agent-icon-image" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <circle cx="8.5" cy="9.5" r="1.5" />
                  <path d="M21 16l-4.6-4.6a1.5 1.5 0 0 0-2.1 0L7 19" />
                </svg>
              </span>
              <div className="login-agent-meta">
                <strong>{t("图片生成")}</strong>
                <span>{t("海报设计与视觉出图")}</span>
              </div>
            </li>
            <li className="login-agent-card">
              <span className="login-agent-icon login-agent-icon-video" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="3" />
                  <path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none" />
                </svg>
              </span>
              <div className="login-agent-meta">
                <strong>{t("视频生成")}</strong>
                <span>{t("分镜脚本与成片生成")}</span>
              </div>
            </li>
            <li className="login-agent-card">
              <span className="login-agent-icon login-agent-icon-ppt" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="12" rx="2.5" />
                  <path d="M8 20h8M12 16v4M7.5 11.5l2.5-2.5 2 2 4-4" />
                </svg>
              </span>
              <div className="login-agent-meta">
                <strong>{t("PPT 制作")}</strong>
                <span>{t("大纲梳理与演示排版")}</span>
              </div>
            </li>
            <li className="login-agent-card">
              <span className="login-agent-icon login-agent-icon-employee" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="8" r="3.5" />
                  <path d="M4.5 20c.7-4 2.9-6 6.5-6s5.8 2 6.5 6" />
                  <path d="M18.5 5.5h3M20 4v3" />
                </svg>
              </span>
              <div className="login-agent-meta">
                <strong>{t("数字员工")}</strong>
                <span>{t("企业经营与营销助手")}</span>
              </div>
            </li>
            <li className="login-agent-card">
              <span className="login-agent-icon login-agent-icon-comic" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2.5" />
                  <path d="M9.5 4v16M15.5 4v16M3 10.5h6.5M15.5 13.5H21" />
                </svg>
              </span>
              <div className="login-agent-meta">
                <strong>{t("漫剧工厂")}</strong>
                <span>{t("专业 AI 漫剧制作平台")}</span>
              </div>
            </li>
          </ul>

          <div className="login-showcase-points">
            <span><i aria-hidden="true" />{t("多模型，按需调用")}</span>
            <span><i aria-hidden="true" />{t("多智能体，协同交付")}</span>
            <span><i aria-hidden="true" />{t("知识库，专属沉淀")}</span>
          </div>
        </div>
      </section>

      <section className="login-access">
        <div className="login-mobile-brand" aria-label={t("万象灵工")}>
          <span className="login-mobile-brand-mark" aria-hidden="true">
            <img src={BRAND_LOGO_SRC} alt="" />
          </span>
          {t("万象灵工")}</div>
        <div className="login-card">
          <LanguageSelect />
          <div className="login-card-heading">
            <h2>{mode === "login" ? t("欢迎回来") : t("创建账号")}</h2>
            <p>{mode === "login" ? t("登录后继续你的智能工作流") : t("注册后即可使用托管 AI 订阅")}</p>
          </div>
          <form className="login-form" onSubmit={handleSubmit}>
            {mode === "login" && registrationEnabled && phoneEnabled && (
              <div className="login-method-tabs" role="tablist" aria-label={t("登录方式")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveLoginMethod === "password"}
                  className={effectiveLoginMethod === "password" ? "active" : ""}
                  onClick={() => { setLoginMethod("password"); setError(null); setNotice(null); }}
                  disabled={loading}
                >{t("用户名密码")}</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveLoginMethod === "phone"}
                  className={effectiveLoginMethod === "phone" ? "active" : ""}
                  onClick={() => { setLoginMethod("phone"); setError(null); setNotice(null); }}
                  disabled={loading}
                >{t("手机号验证码")}</button>
              </div>
            )}

            {(mode === "register" || effectiveLoginMethod === "password") && (
              <div className="login-field">
                <label htmlFor="login-username">{t("用户名")}</label>
                <input
                  id="login-username"
                  type="text"
                  placeholder={t("请输入用户名")}
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
                <span className="login-required-binding"><span aria-hidden>✓</span> {t("邮箱（必填）")}</span>
                {phoneEnabled && <label className="login-checkbox">
                  <input
                    type="checkbox"
                    checked={bindPhone}
                    onChange={(e) => { setBindPhone(e.target.checked); setError(null); setNotice(null); }}
                    disabled={loading}
                  />
                  <span>{t("绑定手机号")}</span>
                </label>}
              </div>
            )}

            {mode === "register" && (
              <div className="login-verification-group">
                <div className="login-field">
                  <label htmlFor="register-email">{t("邮箱")}</label>
                  <div className="login-code-row">
                    <input
                      id="register-email"
                      type="email"
                      placeholder={t("请输入邮箱地址")}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      autoComplete="email"
                      disabled={loading}
                    />
                    <button type="button" onClick={sendEmailCode} disabled={loading || sendingCode !== null || emailCountdown > 0 || !email.trim()}>
                      {sendingCode === "email" ? t("发送中...") : emailCountdown > 0 ? `${emailCountdown}s` : t("发送验证码")}
                    </button>
                  </div>
                </div>
                <div className="login-field">
                  <label htmlFor="register-email-code">{t("邮箱验证码")}</label>
                  <input id="register-email-code" inputMode="numeric" maxLength={6} placeholder={t("请输入 6 位验证码")} value={emailCode} onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ""))} required disabled={loading} />
                </div>
              </div>
            )}

            {((mode === "register" && shouldBindPhone) || (mode === "login" && effectiveLoginMethod === "phone")) && (
              <div className="login-verification-group">
                <div className="login-field">
                  <label htmlFor="login-phone">{t("手机号")}</label>
                  <div className="login-code-row">
                    <input id="login-phone" type="tel" inputMode="tel" placeholder={t("请输入中国大陆手机号")} value={phone} onChange={(e) => setPhone(e.target.value)} required autoFocus={mode === "login"} autoComplete="tel" disabled={loading} />
                    <button type="button" onClick={sendPhoneCode} disabled={loading || sendingCode !== null || phoneCountdown > 0 || !phone.trim()}>
                      {sendingCode === "phone" ? t("发送中...") : phoneCountdown > 0 ? `${phoneCountdown}s` : t("发送验证码")}
                    </button>
                  </div>
                </div>
                <div className="login-field">
                  <label htmlFor="login-phone-code">{t("手机验证码")}</label>
                  <input id="login-phone-code" inputMode="numeric" maxLength={6} placeholder={t("请输入 6 位验证码")} value={phoneCode} onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, ""))} required autoComplete="one-time-code" disabled={loading} />
                </div>
              </div>
            )}

            {(mode === "register" || effectiveLoginMethod === "password") && (
              <div className="login-field">
                <label htmlFor="login-password">{t("密码")}</label>
                <input id="login-password" type="password" placeholder={t("请输入密码")} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={mode === "register" ? "new-password" : "current-password"} disabled={loading} />
              </div>
            )}
            {mode === "login" && effectiveLoginMethod === "password" && registrationEnabled && (
              <button
                type="button"
                className="login-forgot-link"
                onClick={() => {
                  setScreen("forgot");
                  setError(null);
                  setNotice(null);
                }}
                disabled={loading}
              >
                {t("忘记密码？")}</button>
            )}
            {mode === "register" && (
              <div className="login-field">
                <label htmlFor="register-confirm-password">{t("确认密码")}</label>
                <input id="register-confirm-password" type="password" placeholder={t("请再次输入密码")} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required autoComplete="new-password" disabled={loading} />
              </div>
            )}
            {error && <p className="login-error">{t(error)}</p>}
            {notice && <p className="login-notice">{t(notice)}</p>}
            <button
              type="submit"
              className="login-btn"
              disabled={submitDisabled}
            >
              {loading ? (mode === "login" ? t("正在进入...") : t("正在创建...")) : (mode === "login" ? t("进入工作空间") : t("创建并进入"))}
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
              {mode === "login" ? t("没有账号？立即注册") : t("已有账号？返回登录")}
            </button>
          )}
          <div className="login-legal-links">
            <button type="button" onClick={() => setLegalDialog("terms")}>{international ? t("服务条款") : t("用户协议")}</button>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={() => setLegalDialog("privacy")}>{t("隐私政策")}</button>
          </div>
        </div>
        {showCompliance && <footer className="login-compliance" aria-label={t("网站备案与许可信息")}>
          <a
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noreferrer"
          >
            {t("蜀ICP备2025156360号-2")}</a>
          <span>{t("增值电信业务经营许可证：川B2-20260779")}</span>
        </footer>}
      </section>
      {legalDialog && <LegalModal kind={legalDialog} onClose={() => setLegalDialog(null)} />}
    </div>
  );
}

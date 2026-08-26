import { useEffect, useState } from "react";
import { api } from "../api/client.js";

interface PasswordResetProps {
  initialMode: "request" | "confirm";
  initialEmail?: string;
  token?: string;
  onBack: () => void;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function PasswordReset({
  initialMode,
  initialEmail = "",
  token = "",
  onBack,
}: PasswordResetProps) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => {
      setCountdown((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [countdown > 0]);

  const sendResetEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!emailPattern.test(normalizedEmail)) {
      setError("请输入有效的邮箱地址");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.requestPasswordReset(normalizedEmail);
      setEmail(normalizedEmail);
      setCountdown(result.resendAfter || 60);
      setNotice("如果该邮箱已注册，重置链接会发送到你的邮箱，请注意查收。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置邮件发送失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  const confirmReset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 8) {
      setError("密码至少需要 8 位");
      return;
    }
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    if (!token || !email.trim()) {
      setError("重置链接无效，请重新获取重置邮件");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await api.confirmPasswordReset({
        email: email.trim(),
        token,
        password,
        confirmPassword,
      });
      setCompleted(true);
      setNotice("密码已重置成功，请使用新密码登录。");
      window.history.replaceState({}, "", "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "密码重置失败，请重新获取重置邮件");
    } finally {
      setLoading(false);
    }
  };

  const isConfirm = mode === "confirm";
  return (
    <main className="password-reset-page">
      <section className="password-reset-card" aria-labelledby="password-reset-title">
        <div className="password-reset-brand"><span aria-hidden>✦</span> 借势智算</div>
        <p className="password-reset-kicker">ACCOUNT SECURITY</p>
        <h1 id="password-reset-title">{isConfirm ? "重置密码" : "忘记密码"}</h1>
        <p className="password-reset-subtitle">
          {isConfirm ? "请输入新密码并确认，完成账号恢复。" : "输入注册邮箱，我们会发送重置密码的链接。"}
        </p>

        {completed ? (
          <div className="password-reset-complete">
            <p>{notice}</p>
            <button type="button" className="password-reset-button" onClick={onBack}>返回登录</button>
          </div>
        ) : (
          <form className="password-reset-form" onSubmit={isConfirm ? confirmReset : sendResetEmail}>
            <label className="password-reset-field">
              <span>邮箱</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="请输入注册邮箱"
                autoComplete="email"
                required
                disabled={loading || isConfirm}
                autoFocus={!isConfirm}
              />
            </label>

            {isConfirm && (
              <>
                <label className="password-reset-field">
                  <span>新密码</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="请输入新密码"
                    autoComplete="new-password"
                    minLength={8}
                    required
                    disabled={loading}
                    autoFocus
                  />
                </label>
                <label className="password-reset-field">
                  <span>确认密码</span>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="请再次输入新密码"
                    autoComplete="new-password"
                    minLength={8}
                    required
                    disabled={loading}
                  />
                </label>
              </>
            )}

            {error && <p className="password-reset-message error" role="alert">{error}</p>}
            {notice && <p className="password-reset-message success" role="status">{notice}</p>}
            <button
              type="submit"
              className="password-reset-button"
              disabled={loading || (!isConfirm && countdown > 0)}
            >
              {loading ? "处理中..." : isConfirm ? "确认重置密码" : countdown > 0 ? `${countdown}s 后可重新发送` : "发送重置邮件"}
            </button>
          </form>
        )}

        <button
          type="button"
          className="password-reset-back"
          onClick={() => {
            setMode("request");
            setError(null);
            setNotice(null);
            onBack();
          }}
        >
          返回登录
        </button>
      </section>
    </main>
  );
}

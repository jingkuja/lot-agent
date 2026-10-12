import { useI18n } from "../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type ManagedUpload, type User } from "../api/client.js";
import { LegalModal } from "./LegalModal.js";
import { RechargeModal } from "./RechargeModal.js";
import { RechargeHistoryModal } from "./RechargeHistoryModal.js";

interface AccountMenuProps {
  user: User;
  onLogout?: () => void;
}

type Dialog = "recharge" | "recharge-history" | "files" | "phone" | "privacy" | "terms" | null;

function accountText(user: User) {
  const email = user.username ?? user.name ?? "当前账号";
  const displayName = user.name && user.name !== email ? user.name : email.split("@")[0] || email;
  return { email, displayName, initial: (displayName.trim()[0] || "用").toUpperCase() };
}

function maskPhone(phone: string | null | undefined) {
  const value = phone?.trim();
  if (!value) return null;
  if (value.length <= 7) return `${value.slice(0, 3)}****`;
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

export function AccountMenu({ user, onLogout }: AccountMenuProps) {
  const { t, enabled: international } = useI18n();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [boundPhone, setBoundPhone] = useState(() => maskPhone(user.phone));
  const rootRef = useRef<HTMLDivElement>(null);
  const account = accountText(user);

  useEffect(() => {
    setBoundPhone(maskPhone(user.phone));
  }, [user.phone]);

  useEffect(() => {
    const onPhoneBound = (event: Event) => {
      const phone = (event as CustomEvent<{ phone?: string }>).detail?.phone;
      setBoundPhone(maskPhone(phone));
    };
    window.addEventListener("lot:phone-bound", onPhoneBound);
    return () => window.removeEventListener("lot:phone-bound", onPhoneBound);
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setDialog(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const openDialog = (next: Exclude<Dialog, null>) => {
    setOpen(false);
    setDialog(next);
  };

  return (
    <>
      <div className="account-menu-root" ref={rootRef}>
        <button
          type="button"
          className={`account-chip ${open ? "active" : ""}`}
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="account-avatar" aria-hidden>{account.initial}</span>
          <span className="account-chip-label" title={account.email}>{account.email}</span>
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="m6 8 4 4 4-4" />
          </svg>
        </button>

        {open && (
          <div className="account-popover" role="menu">
            <div className="account-popover-profile">
              <span className="account-avatar account-avatar-large" aria-hidden>{account.initial}</span>
              <span>
                <strong>{account.displayName}</strong>
                <small title={account.email}>{account.email}</small>
              </span>
            </div>
            <div className="account-popover-actions">
              <button type="button" role="menuitem" onClick={() => openDialog("recharge")}>
                <span aria-hidden>＋</span>{t("充值")}</button>
              <button type="button" role="menuitem" onClick={() => openDialog("recharge-history")}>
                <span aria-hidden>≡</span>{t("充值明细")}</button>
              <button type="button" role="menuitem" onClick={() => openDialog("files")}>
                <span aria-hidden>▤</span>{t("文件管理")}</button>
              {!international && (boundPhone ? (
                <div className="account-phone-row">
                  <span aria-hidden>☎</span>
                  <span className="account-phone-number" title={t("已绑定手机号")}>{t("手机号")}{boundPhone}</span>
                  <button type="button" className="account-phone-change" onClick={() => openDialog("phone")}>
                    {t("更改")}</button>
                </div>
              ) : (
                <button type="button" role="menuitem" onClick={() => openDialog("phone")}>
                  <span aria-hidden>☎</span>{t("绑定手机号")}</button>
              ))}
              <button type="button" role="menuitem" className="danger" onClick={onLogout}>
                <span aria-hidden>↪</span>{t("退出账号")}</button>
            </div>
            <div className="account-popover-legal">
              <button type="button" onClick={() => openDialog("privacy")}>{t("隐私政策")}</button>
              <span aria-hidden>·</span>
              <button type="button" onClick={() => openDialog("terms")}>{t("用户协议")}</button>
            </div>
          </div>
        )}
      </div>

      {dialog && createPortal(
        <>
          {dialog === "recharge" && <RechargeModal onClose={() => setDialog(null)} />}
          {dialog === "recharge-history" && <RechargeHistoryModal onClose={() => setDialog(null)} />}
          {dialog === "files" && <FileManagerModal onClose={() => setDialog(null)} />}
          {!international && dialog === "phone" && (
            <PhoneBindingModal
              onClose={() => setDialog(null)}
              onSuccess={(phone) => {
                setBoundPhone(maskPhone(phone));
                window.dispatchEvent(new CustomEvent("lot:phone-bound", { detail: { phone } }));
              }}
            />
          )}
          {dialog === "privacy" && <LegalModal kind="privacy" onClose={() => setDialog(null)} />}
          {dialog === "terms" && <LegalModal kind="terms" onClose={() => setDialog(null)} />}
        </>,
        document.body
      )}
    </>
  );
}

const mainlandPhonePattern = /^1[3-9]\d{9}$/;

function PhoneBindingModal({ onClose, onSuccess }: { onClose: () => void; onSuccess?: (phone: string) => void }) {
  const { t } = useI18n();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => {
      setCountdown((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const sendCode = async () => {
    if (!mainlandPhonePattern.test(phone)) {
      setError("请输入有效的中国大陆手机号");
      return;
    }
    setError(null);
    setNotice(null);
    setSending(true);
    try {
      const result = await api.sendPhoneBindingVerification(phone);
      setCountdown(result.resendAfter || 60);
      setNotice("验证码已发送，请注意查收");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "验证码发送失败，请稍后重试");
    } finally {
      setSending(false);
    }
  };

  const bindPhone = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!mainlandPhonePattern.test(phone)) {
      setError("请输入有效的中国大陆手机号");
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError("请输入 6 位短信验证码");
      return;
    }
    setError(null);
    setNotice(null);
    setBinding(true);
    try {
      const result = await api.bindPhone(phone, code);
      onSuccess?.(result.phone);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "手机号绑定失败，请稍后重试");
    } finally {
      setBinding(false);
    }
  };

  return (
    <div className="account-dialog-overlay" onClick={onClose}>
      <section className="account-dialog phone-binding-dialog" role="dialog" aria-modal="true" aria-labelledby="phone-binding-title" onClick={(event) => event.stopPropagation()}>
        <header className="account-dialog-head">
          <span>
            <h2 id="phone-binding-title">{t("绑定/更换手机号")}</h2>
            <p>{t("验证新手机号后，将自动完成绑定或更换。")}</p>
          </span>
          <button type="button" onClick={onClose} aria-label={t("关闭")} disabled={sending || binding}>×</button>
        </header>
        <form className="phone-binding-form" onSubmit={(event) => void bindPhone(event)}>
          <label htmlFor="binding-phone">{t("新手机号")}</label>
          <div className="phone-binding-code-row">
            <input
              id="binding-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={t("请输入中国大陆手机号")}
              value={phone}
              onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))}
              disabled={sending || binding}
            />
            <button type="button" onClick={() => void sendCode()} disabled={sending || binding || countdown > 0 || !phone}>
              {sending ? t("发送中…") : countdown > 0 ? `${countdown}s` : t("发送验证码")}
            </button>
          </div>
          <label htmlFor="binding-code">{t("验证码")}</label>
          <input
            id="binding-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder={t("请输入 6 位短信验证码")}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            disabled={binding}
          />
          {notice && <p className="phone-binding-message success" role="status">{t(notice)}</p>}
          {error && <p className="phone-binding-message error" role="alert">{t(error)}</p>}
          <button className="phone-binding-submit" type="submit" disabled={binding || !mainlandPhonePattern.test(phone) || code.length !== 6}>
            {binding ? t("绑定中…") : t("确认绑定")}
          </button>
        </form>
      </section>
    </div>
  );
}

function FileManagerModal({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const [files, setFiles] = useState<ManagedUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    void api.listUploadedFiles()
      .then(({ data }) => setFiles(data))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "文件加载失败"))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const remove = async (file: ManagedUpload) => {
    if (!window.confirm(t(`确定永久删除“${file.filename}”吗？删除后无法恢复。`))) return;
    setDeletingId(file.id);
    setError(null);
    try {
      await api.deleteUploadedFile(file.id);
      setFiles((current) => current.filter((item) => item.id !== file.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败，请稍后重试");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="account-dialog-overlay" onClick={onClose}>
      <section className="account-dialog file-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="file-manager-title" onClick={(event) => event.stopPropagation()}>
        <header className="account-dialog-head">
          <span>
            <h2 id="file-manager-title">{t("文件管理")}</h2>
            <p>{t("上传文件默认持久化保存，你可以随时查看或永久删除。")}</p>
          </span>
          <button type="button" onClick={onClose} aria-label={t("关闭")}>×</button>
        </header>
        <div className="file-manager-body">
          {loading && <div className="account-dialog-state">{t("正在加载文件…")}</div>}
          {!loading && error && (
            <div className="account-dialog-state error"><span>{t(error)}</span><button type="button" onClick={load}>{t("重新加载")}</button></div>
          )}
          {!loading && !error && files.length === 0 && (
            <div className="account-dialog-state"><span className="file-empty-icon" aria-hidden>▤</span><strong>{t("暂无上传文件")}</strong><small>{t("通过对话上传的文件会显示在这里")}</small></div>
          )}
          {!loading && files.length > 0 && (
            <ul className="managed-file-list">
              {files.map((file) => (
                <li key={file.id}>
                  <span className="managed-file-icon" aria-hidden>{file.mime.startsWith("image/") ? "▧" : "▤"}</span>
                  <span className="managed-file-copy">
                    <a href={file.url} target="_blank" rel="noreferrer" title={file.filename}>{file.filename}</a>
                    <small>{formatBytes(file.size)} · {formatDate(file.createdAt, locale)}</small>
                  </span>
                  <button type="button" className="managed-file-delete" disabled={deletingId === file.id} onClick={() => void remove(file)}>
                    {deletingId === file.id ? t("删除中") : t("删除")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string, locale = "zh-CN") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

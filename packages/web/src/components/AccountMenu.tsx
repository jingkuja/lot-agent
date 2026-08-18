import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type ManagedUpload, type User } from "../api/client.js";

const WALLET_URL = "https://tokenhub.wetok.ai/wallet";

interface AccountMenuProps {
  user: User;
  onLogout?: () => void;
}

type Dialog = "files" | "privacy" | "terms" | null;

function accountText(user: User) {
  const email = user.username ?? user.name ?? "当前账号";
  const displayName = user.name && user.name !== email ? user.name : email.split("@")[0] || email;
  return { email, displayName, initial: (displayName.trim()[0] || "用").toUpperCase() };
}

export function AccountMenu({ user, onLogout }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const account = accountText(user);

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
              <button type="button" role="menuitem" onClick={() => window.open(WALLET_URL, "_blank", "noopener,noreferrer")}>
                <span aria-hidden>＋</span>充值
              </button>
              <button type="button" role="menuitem" onClick={() => openDialog("files")}>
                <span aria-hidden>▤</span>文件管理
              </button>
              <button type="button" role="menuitem" className="danger" onClick={onLogout}>
                <span aria-hidden>↪</span>退出账号
              </button>
            </div>
            <div className="account-popover-legal">
              <button type="button" onClick={() => openDialog("privacy")}>隐私权政策</button>
              <span aria-hidden>·</span>
              <button type="button" onClick={() => openDialog("terms")}>服务协议</button>
            </div>
          </div>
        )}
      </div>

      {dialog && createPortal(
        <>
          {dialog === "files" && <FileManagerModal onClose={() => setDialog(null)} />}
          {dialog === "privacy" && <LegalModal kind="privacy" onClose={() => setDialog(null)} />}
          {dialog === "terms" && <LegalModal kind="terms" onClose={() => setDialog(null)} />}
        </>,
        document.body
      )}
    </>
  );
}

function FileManagerModal({ onClose }: { onClose: () => void }) {
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
    if (!window.confirm(`确定永久删除“${file.filename}”吗？删除后无法恢复。`)) return;
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
            <h2 id="file-manager-title">文件管理</h2>
            <p>上传文件默认持久化保存，你可以随时查看或永久删除。</p>
          </span>
          <button type="button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="file-manager-body">
          {loading && <div className="account-dialog-state">正在加载文件…</div>}
          {!loading && error && (
            <div className="account-dialog-state error"><span>{error}</span><button type="button" onClick={load}>重新加载</button></div>
          )}
          {!loading && !error && files.length === 0 && (
            <div className="account-dialog-state"><span className="file-empty-icon" aria-hidden>▤</span><strong>暂无上传文件</strong><small>通过对话上传的文件会显示在这里</small></div>
          )}
          {!loading && files.length > 0 && (
            <ul className="managed-file-list">
              {files.map((file) => (
                <li key={file.id}>
                  <span className="managed-file-icon" aria-hidden>{file.mime.startsWith("image/") ? "▧" : "▤"}</span>
                  <span className="managed-file-copy">
                    <a href={file.url} target="_blank" rel="noreferrer" title={file.filename}>{file.filename}</a>
                    <small>{formatBytes(file.size)} · {formatDate(file.createdAt)}</small>
                  </span>
                  <button type="button" className="managed-file-delete" disabled={deletingId === file.id} onClick={() => void remove(file)}>
                    {deletingId === file.id ? "删除中" : "删除"}
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

function LegalModal({ kind, onClose }: { kind: "privacy" | "terms"; onClose: () => void }) {
  const privacy = kind === "privacy";
  return (
    <div className="account-dialog-overlay" onClick={onClose}>
      <section className="account-dialog legal-dialog" role="dialog" aria-modal="true" aria-labelledby={`${kind}-title`} onClick={(event) => event.stopPropagation()}>
        <header className="account-dialog-head">
          <span><h2 id={`${kind}-title`}>{privacy ? "隐私权政策" : "服务协议"}</h2><p>更新日期：2026年8月18日</p></span>
          <button type="button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <article className="legal-content">
          {privacy ? <PrivacyPolicy /> : <ServiceTerms />}
        </article>
        <footer className="legal-dialog-footer"><button type="button" onClick={onClose}>我知道了</button></footer>
      </section>
    </div>
  );
}

function PrivacyPolicy() {
  return (
    <>
      <p>灵渠claw重视你的隐私。本政策说明我们在提供AI对话、文件处理、知识库及数字员工服务时，如何处理与你有关的信息。</p>
      <h3>一、我们处理的信息</h3>
      <h4>1. 文字输入与对话</h4>
      <p>你的文字输入仅用于完成当前请求、提供连续对话及展示账户内的历史记录。我们不会将文字输入用于模型训练、广告投放、营销、出售或与服务无关的数据分享。为实现历史会话功能，对话内容会保存在你的账户空间，直至你删除相应会话。</p>
      <h4>2. 用户上传的文件</h4>
      <p>你主动上传的图片、文档、音视频及其他文件默认持久化保存，用于后续会话引用和文件处理。你可以在“文件管理”中随时查看并永久删除；删除后，相关历史会话中的文件链接可能失效。</p>
      <h4>3. 有限度的用户画像</h4>
      <p>为改善交互体验，我们可能在最小必要范围内处理功能偏好、常用能力和交互习惯等信息。此类信息仅用于产品内的体验优化和个性化，不用于广告、营销、用户交易、对外数据共享或任何与服务无关的用途。</p>
      <h3>二、AI推理与必要的数据传输</h3>
      <p>为生成回复，你提交的必要内容会发送至灵渠AI及你所配置的模型服务进行即时推理。相关服务对数据的处理还受其自身规则约束。我们不会向无关第三方出售或提供你的信息，但法律法规另有要求的除外。</p>
      <h3>三、保存、删除与安全</h3>
      <p>我们按照实现服务所需的最短期限保存信息，并采取访问控制、传输保护和账号隔离等合理措施。你可以删除上传文件及会话记录；如法律要求保留安全日志或交易记录，我们会在法定期限内保存并限制用途。</p>
      <h3>四、你的权利</h3>
      <p>你有权访问、更正或删除与你有关的信息，并可停止使用服务。涉及其他个人信息的文件，应确保已取得合法授权。请勿上传国家秘密、违法内容或超出必要范围的敏感个人信息。</p>
      <h3>五、政策更新</h3>
      <p>服务或法律要求发生变化时，我们可能更新本政策。重大变化会通过产品内提示等合理方式告知你。</p>
    </>
  );
}

function ServiceTerms() {
  return (
    <>
      <p>欢迎使用灵渠claw。登录、访问或使用本服务，即表示你已阅读并同意本协议。</p>
      <h3>一、服务基础与配置</h3>
      <p>灵渠claw依托灵渠AI提供AI推理服务。可使用的模型、API Key、额度和推理能力均需先在灵渠AI完成配置并保持有效。因配置缺失、额度不足、模型下线或上游服务异常导致的功能不可用，不视为灵渠claw对服务能力的额外承诺。</p>
      <h3>二、账号范围</h3>
      <p>灵渠claw内的服务、配置、文件、知识库、用量及权益仅限当前登录账号使用。其他账号不能继承、共享或自动获得当前灵渠AI账号已有的服务与权益。你应妥善保管账号凭证，并对账号下的操作负责。</p>
      <h3>三、知识库免费额度</h3>
      <p>灵渠AI知识库的免费使用额度可能根据用户量、资源成本和运营情况调整。调整前已经创建且处于正常状态的知识库将继续免费保留；新增知识库及新增用量适用调整后的规则。调整会通过合理方式提前说明。</p>
      <h3>四、合理使用</h3>
      <p>你不得利用服务生成、上传或传播违法侵权内容，不得绕过安全限制、干扰系统运行、盗用他人账号或实施其他可能损害平台及第三方权益的行为。你应对输入内容及AI输出的最终使用承担责任。</p>
      <h3>五、AI输出说明</h3>
      <p>AI输出可能存在错误、遗漏或时效性限制，仅供辅助参考。涉及医疗、法律、金融、安全或其他重要决策时，应由具备资质的专业人员独立审核，不应将AI输出作为唯一依据。</p>
      <h3>六、知识产权与数据</h3>
      <p>你保留对合法上传内容的相应权利，并授权服务在完成请求所必需的范围内处理这些内容。你应确保上传内容不侵犯他人的知识产权、隐私权或其他合法权益。</p>
      <h3>七、服务变更与中断</h3>
      <p>我们可能因维护、升级、安全风险、法律要求或上游服务变化调整部分功能。我们会尽合理努力保障服务稳定，但不对不可抗力、网络故障或第三方服务异常造成的中断作绝对可用性保证。</p>
      <h3>八、协议更新</h3>
      <p>本协议可能随服务变化进行更新。更新后的协议公布后生效；如你不同意更新内容，应停止使用相关服务。</p>
    </>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

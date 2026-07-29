import { useEffect, useState } from "react";

interface ServerSettingsModalProps {
  onClose: () => void;
}

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "ok" }
  | { kind: "err"; message: string };

/**
 * Desktop-only server-endpoint settings. Talks to the Electron main process
 * through the `window.lotDesktop` bridge (probe /health + persist), so unlike
 * the loopback server's `/__lot/setup` page it works in BOTH the packaged app
 * and the vite dev window.
 *
 * Note: in dev the vite proxy re-reads the same config.json per request (see
 * vite.config.ts), so saving here also retargets the dev window immediately.
 */
export function ServerSettingsModal({ onClose }: ServerSettingsModalProps) {
  const desktop = window.lotDesktop;
  const [url, setUrl] = useState(() => desktop?.getServerUrl() ?? "");
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!desktop) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || status.kind === "saving") return;
    setStatus({ kind: "saving" });
    try {
      const res = await desktop.setServerUrl(url);
      if (res.ok) setStatus({ kind: "ok" });
      else setStatus({ kind: "err", message: res.error ?? "连接失败" });
    } catch (error) {
      setStatus({
        kind: "err",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="agent-center-overlay" onClick={onClose}>
      <div
        className="agent-center-modal server-settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="agent-center-head">
          <h2 className="agent-center-title">服务器设置</h2>
          <button className="agent-center-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <form className="server-settings-form" onSubmit={handleSave}>
          <label className="server-settings-label" htmlFor="server-url-input">
            服务器地址
          </label>
          <input
            id="server-url-input"
            type="text"
            placeholder="http://192.168.1.10 或 https://agent.example.com"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (status.kind !== "idle") setStatus({ kind: "idle" });
            }}
            autoFocus
            disabled={status.kind === "saving"}
          />
          {status.kind === "err" && (
            <p className="server-settings-msg is-error">{status.message}</p>
          )}
          {status.kind === "ok" && (
            <p className="server-settings-msg is-ok">已保存，连接成功</p>
          )}
          <button
            type="submit"
            className="login-btn"
            disabled={status.kind === "saving" || !url.trim()}
          >
            {status.kind === "saving" ? "正在连接…" : "保存并连接"}
          </button>
        </form>
      </div>
    </div>
  );
}

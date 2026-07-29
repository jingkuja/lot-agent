import { useEffect, useState } from "react";
import type { DesktopDownloadEvent } from "../types/desktop.js";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** How long a finished toast lingers before dismissing itself. */
const AUTO_DISMISS_MS: Record<string, number> = {
  completed: 12000,
  cancelled: 4000,
  interrupted: 8000,
};

/**
 * Desktop-only native-download progress toasts. The main process pushes
 * `DesktopDownloadEvent`s over IPC as a download moves through
 * save-dialog → progressing → completed/cancelled/interrupted. Completed
 * downloads offer "打开" / "所在文件夹" via the OS shell.
 *
 * Renders nothing in a plain browser (where `<a download>` just works).
 */
export function DownloadToast() {
  const desktop = typeof window !== "undefined" ? window.lotDesktop : undefined;
  const [items, setItems] = useState<DesktopDownloadEvent[]>([]);

  useEffect(() => {
    if (!desktop) return;
    return desktop.onDownloadEvent((event) => {
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.id === event.id);
        if (idx === -1) return [...prev, event];
        const next = [...prev];
        next[idx] = event;
        return next;
      });
    });
  }, [desktop]);

  // Auto-dismiss toasts that reached a terminal state.
  useEffect(() => {
    const timers = items
      .filter((i) => i.state !== "progressing")
      .map((i) =>
        setTimeout(
          () => setItems((prev) => prev.filter((p) => p.id !== i.id)),
          AUTO_DISMISS_MS[i.state] ?? 6000
        )
      );
    return () => timers.forEach(clearTimeout);
  }, [items]);

  if (!desktop || items.length === 0) return null;

  const dismiss = (id: string) =>
    setItems((prev) => prev.filter((p) => p.id !== id));

  return (
    <div className="download-toasts">
      {items.map((item) => {
        const pct =
          item.totalBytes > 0
            ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100))
            : null;
        return (
          <div key={item.id} className={`download-toast is-${item.state}`}>
            <div className="download-toast-head">
              <span className="download-toast-name" title={item.filename}>
                {item.filename}
              </span>
              <button
                type="button"
                className="download-toast-close"
                aria-label="关闭"
                onClick={() => dismiss(item.id)}
              >
                ✕
              </button>
            </div>

            {item.state === "progressing" && (
              <>
                <div className="download-toast-bar">
                  <div
                    className={`download-toast-bar-fill${pct === null ? " indeterminate" : ""}`}
                    style={pct === null ? undefined : { width: `${pct}%` }}
                  />
                </div>
                <div className="download-toast-status">
                  {pct === null
                    ? formatBytes(item.receivedBytes)
                    : `${pct}% · ${formatBytes(item.receivedBytes)} / ${formatBytes(item.totalBytes)}`}
                </div>
              </>
            )}

            {item.state === "completed" && (
              <div className="download-toast-actions">
                <button
                  type="button"
                  onClick={() => item.path && desktop.openPath(item.path)}
                >
                  打开
                </button>
                <button
                  type="button"
                  onClick={() => item.path && desktop.showInFolder(item.path)}
                >
                  所在文件夹
                </button>
              </div>
            )}

            {item.state === "interrupted" && (
              <div className="download-toast-status is-error">下载中断</div>
            )}
            {item.state === "cancelled" && (
              <div className="download-toast-status">已取消</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

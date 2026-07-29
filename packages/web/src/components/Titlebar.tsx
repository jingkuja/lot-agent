import { useEffect, useState } from "react";

/**
 * Desktop-only titlebar, rendered only inside the Electron shell
 * (`window.lotDesktop` present):
 * - **macOS**: a pure drag region — the native traffic lights are inset by
 *   `titleBarStyle: "hiddenInset"`, so we just leave room for them.
 * - **Windows** (frameless window): drag region + min/maximize/close buttons
 *   wired to the main process via the bridge.
 *
 * Double-clicking the drag region toggles maximize, matching native behavior.
 */
export function Titlebar() {
  const desktop = typeof window !== "undefined" ? window.lotDesktop : undefined;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    return desktop.onWindowMaximizedChange(setMaximized);
  }, [desktop]);

  if (!desktop) return null;
  const isMac = desktop.platform === "darwin";

  return (
    <div
      className={`titlebar ${isMac ? "titlebar-mac" : "titlebar-win"}`}
      onDoubleClick={(e) => {
        // Only the drag surface toggles maximize — not the buttons.
        if ((e.target as HTMLElement).closest(".titlebar-controls")) return;
        desktop.windowToggleMaximize();
      }}
    >
      <div className="titlebar-drag">
        <span className="titlebar-title">借势智算</span>
      </div>
      {!isMac && (
        <div className="titlebar-controls">
          <button
            type="button"
            className="titlebar-btn"
            aria-label="最小化"
            onClick={() => desktop.windowMinimize()}
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <button
            type="button"
            className="titlebar-btn"
            aria-label={maximized ? "还原" : "最大化"}
            onClick={() => desktop.windowToggleMaximize()}
          >
            {maximized ? (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="3" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <path d="M1 3v8h8" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="titlebar-btn titlebar-btn-close"
            aria-label="关闭"
            onClick={() => desktop.windowClose()}
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

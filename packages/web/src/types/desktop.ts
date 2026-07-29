/**
 * Bridge between the web renderer and the Electron desktop shell
 * (`packages/desktop`). The preload script exposes an implementation as
 * `window.lotDesktop`; in a plain browser it is `undefined` and every
 * consumer must fall back to browser behavior (localStorage, window.alert…).
 *
 * This file is the single source of truth for the bridge's shape — the
 * desktop package imports these types, so keep the two in sync here.
 */

export type DesktopPlatform = "darwin" | "win32" | "linux";

export interface DesktopDownloadEvent {
  id: string;
  filename: string;
  totalBytes: number;
  receivedBytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  /** Absolute save path, present once completed. */
  path?: string;
  error?: string;
}

export interface LotDesktopBridge {
  platform: DesktopPlatform;
  appVersion: string;

  // ── Token (secure storage: Keychain / DPAPI on the main-process side) ──────
  /** Sync read of the token captured at startup; the renderer keeps its own
   * in-memory copy afterwards. */
  getToken(): string | null;
  /** Fire-and-forget persist; `null` clears. */
  setToken(token: string | null): void;

  // ── Server endpoint configuration ──────────────────────────────────────────
  getServerUrl(): string | null;
  /** Persists the url after probing `<url>/health`; resolves with an error
   * message instead of throwing when unreachable. */
  setServerUrl(url: string): Promise<{ ok: boolean; error?: string }>;

  // ── Window controls (used by the custom frameless titlebar on Windows;
  // no-ops on macOS where the native traffic lights are inset) ────────────────
  windowMinimize(): void;
  windowToggleMaximize(): void;
  windowClose(): void;
  onWindowMaximizedChange(cb: (maximized: boolean) => void): () => void;

  // ── Notifications / attention ───────────────────────────────────────────────
  /** System notification (no-op when the window is focused — the shell
   * decides). */
  notify(title: string, body?: string): void;
  /** Dock badge on macOS, flashFrame on Windows; 0 clears. */
  setAttention(count: number): void;

  // ── Native downloads ────────────────────────────────────────────────────────
  onDownloadEvent(cb: (event: DesktopDownloadEvent) => void): () => void;
  showInFolder(path: string): void;
  openPath(path: string): void;

  // ── Misc ────────────────────────────────────────────────────────────────────
  /** Native alert dialog replacement for `window.alert`. */
  showAlert(message: string): void;
}

declare global {
  interface Window {
    lotDesktop?: LotDesktopBridge;
  }
}

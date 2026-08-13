/**
 * Replaceable wrapper around `window.alert`. On the desktop shell the bridge
 * shows a native dialog; in the browser it falls back to `window.alert`.
 * Keeping every call site behind this function means the desktop app never
 * relies on Chromium's (rather ugly) default alert.
 */
export function showAlert(message: string): void {
  const bridge =
    typeof window !== "undefined" ? window.lotDesktop : undefined;
  if (bridge) {
    bridge.showAlert(message);
    return;
  }
  window.alert(message);
}

/**
 * System notification for background completion events (image/video/doc
 * generation). The desktop shell shows a native notification only when the
 * window isn't focused and also raises the dock/taskbar attention indicator;
 * in a plain browser this is a no-op.
 */
export function notifyDesktop(title: string, body?: string): void {
  const bridge =
    typeof window !== "undefined" ? window.lotDesktop : undefined;
  bridge?.notify(title, body);
}

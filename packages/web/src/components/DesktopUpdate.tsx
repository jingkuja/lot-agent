import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/index.js";
import type { DesktopUpdateState } from "../types/desktop.js";

const COPY: Record<DesktopUpdateState["status"], string> = {
  disabled: "此安装包尚未配置自动更新", idle: "可检查应用更新", checking: "正在检查更新…",
  current: "当前已是最新版本", downloading: "正在下载更新…", ready: "更新已下载，可以重启安装",
  installing: "正在准备重启更新，请勿关闭电脑", error: "更新失败，请重试或使用安装包手动更新",
  manual: "安装包已打开，请退出应用后手动安装",
};

export function DesktopUpdate() {
  const bridge = window.lotDesktop;
  const { t } = useI18n();
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const announced = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!bridge?.getUpdateState) return;
    let active = true;
    const apply = (next: DesktopUpdateState) => { if (active) setState(next); };
    const unsubscribe = bridge.onUpdateState(apply);
    void bridge.getUpdateState().then(apply).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  useEffect(() => {
    if (state?.status === "ready" && announced.current !== state.version) {
      announced.current = state.version;
      dialog.current?.showModal();
    }
  }, [state?.status, state?.version]);
  if (!bridge?.getUpdateState || !state) return null;
  const busy = requesting || ["checking", "downloading", "installing"].includes(state.status);
  const request = async (action: () => Promise<DesktopUpdateState>) => {
    setRequesting(true);
    setBlocked(false);
    try { const next = await action(); setState(next); setBlocked(!!next.blocked); }
    catch { setState(previous => previous && { ...previous, status: "error" }); }
    finally { setRequesting(false); }
  };
  const install = () => {
    // Listeners synchronously inspect all streams and composer drafts. The
    // modal blocks new input while the main process acquires the local-tool lock.
    const event = new Event("lot:before-update", { cancelable: true });
    if (!window.dispatchEvent(event)) { setBlocked(true); return; }
    void request(() => bridge.installUpdate());
  };
  return <>
    <button className="desktop-update-trigger" onClick={() => dialog.current?.showModal()}>
      {t(state.status === "ready" ? "重启更新" : "应用更新")}
    </button>
    <dialog ref={dialog} className="desktop-update-dialog" aria-labelledby="desktop-update-title"
      onCancel={event => { if (state.status === "installing" || requesting) event.preventDefault(); }}>
      <h2 id="desktop-update-title">{t("应用更新")}</h2>
      <p>{t("当前版本")} {state.currentVersion}{state.version ? ` → ${state.version}` : ""}</p>
      <p role="status">{t(COPY[state.status])}</p>
      {state.status === "downloading" && <progress max={100} value={state.progress} aria-label={t("下载进度")} />}
      {state.notes && <p className="desktop-update-notes">{state.notes}</p>}
      {blocked && <p role="alert">{t("请先等待任务结束，并发送或清空未发送的草稿和附件，再重启更新。")}</p>}
      {bridge.platform === "darwin" && state.manualAvailable && <p>{t("若系统阻止打开，请在系统设置的隐私与安全性中允许。手动安装时请将应用拖到应用程序文件夹。")}</p>}
      <footer>
        <button disabled={busy || state.status === "disabled" || state.status === "ready"} onClick={() => void request(() => bridge.checkForUpdates())}>{t("检查更新")}</button>
        {state.manualAvailable && <button disabled={busy} onClick={() => void request(() => bridge.openUpdateInstaller())}>{t(bridge.platform === "darwin" ? "下载 DMG 手动安装" : "下载安装包")}</button>}
        {state.status === "ready" && <button disabled={busy} onClick={install}>{t("重启并更新")}</button>}
        <button disabled={state.status === "installing" || requesting} onClick={() => dialog.current?.close()}>{t("稍后")}</button>
      </footer>
    </dialog>
  </>;
}

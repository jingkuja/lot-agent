import { useEffect, useState } from "react";
import { useI18n } from "../i18n/index.js";
import type { LocalWorkspaceState } from "../types/desktop.js";

export function DesktopWorkspace({ disabled }: { disabled: boolean }) {
  const { t } = useI18n();
  const desktop = window.lotDesktop;
  const [state, setState] = useState<LocalWorkspaceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    const refresh = () => { void desktop.getLocalWorkspace().then(value => { if (alive) setState(value); }).catch(() => {}); };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 2000);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [desktop]);
  if (!desktop) return null;
  async function change(action: "choose" | "disable") {
    setBusy(true);
    setError("");
    try { setState(await (action === "choose" ? desktop!.chooseLocalWorkspace() : desktop!.disableLocalWorkspace())); }
    catch { setError(t("本地工作目录操作失败，请停止本地任务后重试")); }
    finally { setBusy(false); }
  }
  return <section className="desktop-workspace" aria-label={t("本地工作目录")}>
    <div className="desktop-workspace-heading">
      <span className={`desktop-workspace-indicator${state?.directory ? " enabled" : ""}`} aria-hidden="true" />
      <strong>{t("本地工作目录")}</strong>
      <span className="desktop-workspace-path" title={state?.directory ?? undefined}>{state?.directory ?? t("未启用本地工具")}</span>
      <button type="button" disabled={busy || disabled || !!state?.activeRuns} onClick={() => void change("choose")}>{t(state?.directory ? "更换目录" : "选择目录")}</button>
      {state?.directory && <button type="button" disabled={busy} onClick={() => void change("disable")}>{t("停用本地工具")}</button>}
    </div>
    <p>{state?.directory ? t("已启用目录列表、文件读取与编辑。Bash 和文件修改执行前需确认；读取内容与命令输出将发送给模型并保存在聊天记录中。") : t("选择电脑上的目录，让通用助手处理本地文件或运行 Bash。")}</p>
    {state?.directory && !state.bashAvailable && <p role="status">{t("未检测到 Bash。Windows 请安装 Git Bash；本地文件工具仍可使用。")}</p>}
    {!!state?.activeRuns && <p role="status">{t("本地工具已连接，停止聊天可取消当前操作。")}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

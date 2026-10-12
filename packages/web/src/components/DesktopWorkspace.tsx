import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/index.js";
import type { DesktopWorkspaceControl } from "../hooks/useDesktopWorkspace.js";
import type { LocalPermissionMode } from "../types/desktop.js";

const modes: { value: LocalPermissionMode; label: string; description: string }[] = [
  { value: "always", label: "每次确认", description: "每次修改文件或执行命令前批准" },
  { value: "conversation", label: "本次对话确认", description: "首次批准后，本次对话内自动执行" },
  { value: "full", label: "完全授权", description: "本次对话内自动执行，无需逐次批准" },
];

export function PermissionIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>;
}

export function DesktopWorkspace({ disabled, control }: { disabled: boolean; control: DesktopWorkspaceControl }) {
  const { t } = useI18n();
  const { state, busy, error } = control;
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const above = rect.top;
      const below = window.innerHeight - rect.bottom;
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 342)),
        ...(above >= below ? { bottom: window.innerHeight - rect.top + 8, top: undefined } : { top: rect.bottom + 8, bottom: undefined }),
        maxHeight: Math.max(100, Math.max(above, below) - 24) });
    };
    place();
    menu.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  if (!control.available) return null;
  const mode = state?.permissionMode ?? "always";
  return <div className="desktop-workspace" ref={container}>
    <button ref={trigger} type="button" className={`desktop-permission-trigger${mode === "full" ? " is-full" : ""}`} aria-expanded={open} aria-label={t("工具权限")} onClick={() => setOpen(!open)}>
      <PermissionIcon /><span>{t(modes.find(item => item.value === mode)!.label)}</span><span aria-hidden="true" className="desktop-permission-chevron">⌄</span>
    </button>
    {open && createPortal(<section ref={menu} style={position} className="desktop-permission-menu" aria-label={t("工具权限")}>
      <div className="desktop-permission-heading"><strong>{t("工具权限")}</strong><span>{t("仅此对话")}</span></div>
      <div className="desktop-permission-options" role="group" aria-label={t("工具权限")}>
        {modes.map(item => <button key={item.value} type="button" aria-pressed={mode === item.value} disabled={busy || !state} onClick={() => void control.setMode(item.value)}>
          <span className="desktop-permission-check" aria-hidden="true">{mode === item.value ? "✓" : ""}</span>
          <span><strong>{t(item.label)}</strong><small>{t(item.description)}</small></span>
        </button>)}
      </div>
      <div className="desktop-permission-folder">
        <strong>{t("本地工作目录")}</strong>
        <span className="desktop-workspace-path" title={state?.directory ?? undefined}>{state?.directory ?? t("未启用本地工具")}</span>
        <div><button type="button" disabled={busy || disabled || !!state?.activeRuns} onClick={() => void control.choose()}>{t(state?.directory ? "更换目录" : "选择目录")}</button>
          {state?.directory && <button type="button" disabled={busy} onClick={() => void control.disable()}>{t("停用本地工具")}</button>}</div>
        <p>{t("读取内容与命令输出将发送给模型并保存在聊天记录中。")}</p>
        <p>{t("命令可访问工作目录之外的文件和网络。")}</p>
        {state?.directory && !state.shell && <p role="status">{t("系统命令环境不可用；本地文件工具仍可使用。")}</p>}
      </div>
      {error && <p role="alert">{t("权限操作失败，请重试；该请求可能已取消。")}</p>}
    </section>, document.body)}
  </div>;
}

export function DesktopApprovalCards({ control }: { control: DesktopWorkspaceControl }) {
  const { t } = useI18n();
  return <>{control.state?.approvals.map(approval => <section key={approval.id} className="desktop-approval" aria-label={t("等待批准")}>
    <div className="desktop-approval-heading"><span className="desktop-approval-icon"><PermissionIcon /></span><div><strong>{t((approval.name === "desktop_bash" || approval.name === "desktop_powershell") ? "允许执行此命令？" : approval.name === "desktop_delete_file" ? "允许永久删除此文件？" : "允许修改此文件？")}</strong><span>{t("等待批准")}</span></div></div>
    <pre tabIndex={0}>{approval.detail}</pre>
    {(approval.name === "desktop_bash" || approval.name === "desktop_powershell") && <p>{t("命令可访问工作目录之外的文件和网络。")}</p>}
    <div className="desktop-approval-actions">
      <button type="button" disabled={control.busy} onClick={() => void control.respond(approval.id, "deny")}>{t("拒绝执行")}</button>
      <div><button type="button" className={control.state?.permissionMode === "conversation" ? "desktop-approval-primary" : undefined} disabled={control.busy} onClick={() => void control.respond(approval.id, "conversation")}>{t("本次对话允许")}</button>
        <button type="button" className={control.state?.permissionMode !== "conversation" ? "desktop-approval-primary" : undefined} disabled={control.busy} onClick={() => void control.respond(approval.id, "once")}>{t("允许一次")}</button></div>
    </div>
    {control.error && <p role="alert">{t("权限操作失败，请重试；该请求可能已取消。")}</p>}
  </section>)}</>;
}

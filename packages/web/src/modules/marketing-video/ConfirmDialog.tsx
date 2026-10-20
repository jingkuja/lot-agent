import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/index.js";

/** Interface copy keys; values fill `{0}` placeholders in the message. */
export interface ConfirmRequest { title: string; message: string; values?: (string | number)[]; confirm: string; cancel?: string }

/** A modal confirmation in the app's dialog style (see AgentSwitchDialog). */
function ConfirmDialog({ title, message, values, confirm, cancel = "取消", onClose }: ConfirmRequest & { onClose(ok: boolean): void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId(); const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="agent-switch-dialog mv-confirm-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onClose(false); }}>
    <h2 id={titleId}>{t(title)}</h2>
    <p id={descriptionId}>{t(message, values)}</p>
    <div className="agent-switch-dialog-actions">
      <button type="button" autoFocus onClick={() => onClose(false)}>{t(cancel)}</button>
      <button type="button" className="primary" onClick={() => onClose(true)}>{t(confirm)}</button>
    </div>
  </dialog>;
}

/** `confirm` resolves true only when the user picks the confirm action; render `dialog`. */
export function useConfirm(): [ReactNode, (request: ConfirmRequest) => Promise<boolean>] {
  const [open, setOpen] = useState<(ConfirmRequest & { resolve(ok: boolean): void }) | null>(null);
  const confirm = (request: ConfirmRequest) => new Promise<boolean>(resolve => setOpen({ ...request, resolve }));
  const dialog = open && <ConfirmDialog {...open} onClose={ok => { open.resolve(ok); setOpen(null); }} />;
  return [dialog, confirm];
}

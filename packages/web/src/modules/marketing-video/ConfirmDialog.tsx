import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/index.js";

/** Interface copy keys; values fill `{0}` placeholders in the message. `danger`: the action deletes, stops or discards something.
 * `alternative`: a second action beside `confirm`, offered through `choose`. */
export interface ConfirmRequest {
  title: string; message: string; values?: (string | number)[]; confirm: string; cancel?: string; danger?: boolean; alternative?: string;
}
/** What the user picked; null when the dialog was cancelled or dismissed. */
export type ConfirmChoice = "confirm" | "alternative" | null;

/** A modal confirmation in the app's dialog style (see AgentSwitchDialog). */
function ConfirmDialog({ title, message, values, confirm, cancel = "取消", danger = false, alternative, onClose }: ConfirmRequest & {
  onClose(choice: ConfirmChoice): void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId(); const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="agent-switch-dialog mv-confirm-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onClose(null); }}>
    <h2 id={titleId}>{t(title)}</h2>
    <p id={descriptionId}>{t(message, values)}</p>
    <div className="agent-switch-dialog-actions">
      <button type="button" autoFocus onClick={() => onClose(null)}>{t(cancel)}</button>
      {alternative && <button type="button" onClick={() => onClose("alternative")}>{t(alternative)}</button>}
      <button type="button" className={danger ? "danger" : "primary"} onClick={() => onClose("confirm")}>{t(confirm)}</button>
    </div>
  </dialog>;
}

/** `confirm` resolves true only when the user picks the confirm action; `choose` also tells the alternative
 * action from a cancel. Render `dialog`. */
export function useConfirm(): [ReactNode, (request: ConfirmRequest) => Promise<boolean>, (request: ConfirmRequest) => Promise<ConfirmChoice>] {
  const [open, setOpen] = useState<(ConfirmRequest & { resolve(choice: ConfirmChoice): void }) | null>(null);
  const choose = (request: ConfirmRequest) => new Promise<ConfirmChoice>(resolve => setOpen({ ...request, resolve }));
  const confirm = async (request: ConfirmRequest) => await choose({ ...request, alternative: undefined }) === "confirm";
  const dialog = open && <ConfirmDialog {...open} onClose={choice => { open.resolve(choice); setOpen(null); }} />;
  return [dialog, confirm, choose];
}

export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * Enter submits a composer only when it is not being used to confirm an IME
 * candidate. keyCode 229 is retained as a fallback for browsers that do not
 * reliably expose KeyboardEvent.isComposing during composition.
 */
export function shouldSubmitComposer(
  event: ComposerKeyEvent,
  compositionActive = false
): boolean {
  return event.key === "Enter"
    && !event.shiftKey
    && !compositionActive
    && !event.isComposing
    && event.keyCode !== 229;
}

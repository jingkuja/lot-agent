export type FocusType = "customer" | "segment" | "campaign" | "asset" | "product";

export interface EmployeeFocus {
  type: FocusType;
  id: string;
  label: string;
}

/** Older conversations kept only a customer; both forms stay readable. */
export function readConversationFocus(metadata: Record<string, unknown> | undefined): EmployeeFocus | null {
  const focus = metadata?.digitalEmployeeFocus as Partial<EmployeeFocus> | undefined;
  if (focus && typeof focus.id === "string" && typeof focus.label === "string" && focus.type) {
    return { type: focus.type, id: focus.id, label: focus.label };
  }
  const legacy = metadata?.digitalEmployeeCurrentProfile as { id?: unknown; displayName?: unknown } | undefined;
  return typeof legacy?.id === "string" && typeof legacy.displayName === "string"
    ? { type: "customer", id: legacy.id, label: legacy.displayName }
    : null;
}

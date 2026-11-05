export const DIGITAL_EMPLOYEE_MODULE_SCOPES = [
  "marketing-materials",
  "customer-profile",
  "opportunity-advisor",
  "customer-acquisition",
] as const;

/** One employee across customers, follow-ups, groups, campaigns and materials. */
export const DIGITAL_EMPLOYEE_UNIFIED_SCOPE = "employee";

export const DIGITAL_EMPLOYEE_FEATURE_SCOPES = [...DIGITAL_EMPLOYEE_MODULE_SCOPES, DIGITAL_EMPLOYEE_UNIFIED_SCOPE] as const;

export type DigitalEmployeeFeatureScope = typeof DIGITAL_EMPLOYEE_FEATURE_SCOPES[number];

const ALLOWED = new Set<string>(DIGITAL_EMPLOYEE_FEATURE_SCOPES);

/** Legal scopes on a stored conversation; `employee` stays readable with the switch off. */
export function parseDigitalEmployeeFeatureScope(value: unknown): DigitalEmployeeFeatureScope | undefined {
  return typeof value === "string" && ALLOWED.has(value)
    ? value as DigitalEmployeeFeatureScope
    : undefined;
}

export function readConversationFeatureScope(metadata: unknown): DigitalEmployeeFeatureScope | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return parseDigitalEmployeeFeatureScope(
    (metadata as Record<string, unknown>).digitalEmployeeFeatureScope
  );
}

/** The workspace has only `employee` conversations, so its switch implies this one. */
export function digitalEmployeeUnifiedEnabled(): boolean {
  return process.env.DIGITAL_EMPLOYEE_UNIFIED === "1" || digitalEmployeeWorkspaceEnabled();
}

export function digitalEmployeeWorkspaceEnabled(): boolean {
  return process.env.DIGITAL_EMPLOYEE_WORKSPACE === "1";
}

/** Scans feed the today page, so they stay off until the workspace is on. */
export function digitalEmployeeDailyScanEnabled(): boolean {
  return process.env.DIGITAL_EMPLOYEE_DAILY_SCAN === "1" && digitalEmployeeWorkspaceEnabled();
}

/** What the signed-out product config tells the web shell. */
export function digitalEmployeeProductFlags() {
  return {
    digitalEmployeeUnified: digitalEmployeeUnifiedEnabled(),
    digitalEmployeeWorkspace: digitalEmployeeWorkspaceEnabled(),
    digitalEmployeeDailyScan: digitalEmployeeDailyScanEnabled(),
  };
}

/** The scope a new conversation is stored with. The server decides `employee`:
 * clients keep sending their module scope until the old entries are removed. */
export function newConversationFeatureScope(
  requested: unknown,
  unified = digitalEmployeeUnifiedEnabled()
): DigitalEmployeeFeatureScope | undefined {
  if (unified) return DIGITAL_EMPLOYEE_UNIFIED_SCOPE;
  const scope = parseDigitalEmployeeFeatureScope(requested);
  return scope === DIGITAL_EMPLOYEE_UNIFIED_SCOPE ? undefined : scope;
}

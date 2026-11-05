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

/** Legal scopes on a stored conversation. New ones are always `employee`; module scopes are older chats. */
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

export function digitalEmployeeDailyScanEnabled(): boolean {
  return process.env.DIGITAL_EMPLOYEE_DAILY_SCAN === "1";
}

/** Separate from the daily scan: scheduled work spends the owner's model budget and the scan does not. */
export function digitalEmployeeSchedulesEnabled(): boolean {
  return process.env.DIGITAL_EMPLOYEE_SCHEDULES === "1";
}

/** What the signed-out product config tells the web shell. */
export function digitalEmployeeProductFlags() {
  return { digitalEmployeeDailyScan: digitalEmployeeDailyScanEnabled(), digitalEmployeeSchedules: digitalEmployeeSchedulesEnabled() };
}

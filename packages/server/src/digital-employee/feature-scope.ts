export const DIGITAL_EMPLOYEE_FEATURE_SCOPES = [
  "marketing-materials",
  "customer-profile",
  "opportunity-advisor",
  "customer-acquisition",
] as const;

export type DigitalEmployeeFeatureScope = typeof DIGITAL_EMPLOYEE_FEATURE_SCOPES[number];

const ALLOWED = new Set<string>(DIGITAL_EMPLOYEE_FEATURE_SCOPES);

/** Only the four in-app workspaces are legal conversation scopes. */
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

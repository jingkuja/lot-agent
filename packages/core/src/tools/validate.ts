import type { JSONSchema } from "../types/index.js";

const JS_TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
};

/**
 * Shallow JSON-schema validation: checks `required` fields are present and,
 * for each declared property, that the runtime type matches the schema's
 * `type`. No recursion into nested schemas, no format/pattern/enum support —
 * deliberately minimal (a hand-rolled checker instead of adding an Ajv
 * dependency). Returns an empty array when the input is valid.
 */
export function validateToolInput(schema: JSONSchema, input: unknown): string[] {
  const errors: string[] = [];
  const properties = (schema.properties as Record<string, JSONSchema>) ?? {};
  const required = (schema.required as string[]) ?? [];
  const obj = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;

  for (const key of required) {
    if (!(key in obj) || obj[key] === undefined) {
      errors.push(`missing required field "${key}"`);
    }
  }

  for (const [key, propSchema] of Object.entries(properties)) {
    if (!(key in obj) || obj[key] === undefined) continue; // optional/absent — nothing to check
    const expectedType = propSchema.type as string | undefined;
    const check = expectedType ? JS_TYPE_CHECKS[expectedType] : undefined;
    if (check && !check(obj[key])) {
      errors.push(`field "${key}" must be of type ${expectedType}, got ${typeof obj[key]}`);
    }
  }

  return errors;
}

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { JSONSchema } from "../types/index.js";

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, ownProperties: true });
addFormats(ajv);
const validators = new WeakMap<JSONSchema, ValidateFunction>();

/** Full, non-coercing JSON Schema validation shared by tool inputs and answers. */
export function validateToolInput(schema: JSONSchema, input: unknown): string[] {
  try {
    let validate = validators.get(schema);
    if (!validate) {
      validate = ajv.compile(schema);
      validators.set(schema, validate);
    }
    if (validate(input)) return [];
    return (validate.errors ?? []).map(error => {
      if (error.keyword === "required") {
        return `${error.instancePath ? `${error.instancePath}: ` : ""}missing required field "${error.params.missingProperty}"`;
      }
      return `field "${error.instancePath.replace(/^\//, "") || "$"}" ${error.message}`;
    });
  } catch {
    return ["Invalid JSON schema for validation"];
  }
}

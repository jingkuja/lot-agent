import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
/** Test-only executable checks against the published OpenAPI schemas. */
export const contract = JSON.parse(readFileSync(new URL("../../../../../docs/knowledge-openapi.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false, allowUnionTypes: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(contract, "knowledge");
export const validateRequest = ajv.compile({ $ref: "knowledge#/components/schemas/RetrievalRequest" });
export const validateResult = ajv.compile({ $ref: "knowledge#/components/schemas/RetrievalResult" });
export const validateError = ajv.compile({ $ref: "knowledge#/components/schemas/Error" });

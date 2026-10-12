import type { Tool, ToolResult } from "../types/index.js";

/** Transport-only definitions: this module never accesses the host machine. */
export const localToolDefinitions: Omit<Tool, "execute">[] = [
  { name: "desktop_list_files", effect: "read", description: "List entries in the user's selected desktop directory.", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string", maxLength: 4096 } } } },
  { name: "desktop_read_file", effect: "read", description: "Read a UTF-8 local file in the user's selected desktop directory (max 1 MB).", parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1, maxLength: 4096 } } } },
  { name: "desktop_write_file", effect: "write", description: "Create a new UTF-8 local file. Refuses to overwrite an existing file; use desktop_edit_file for changes. Parent directory must exist.", parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string", minLength: 1, maxLength: 4096 }, content: { type: "string", maxLength: 500000 } } } },
  { name: "desktop_edit_file", effect: "write", description: "Replace exactly one occurrence of oldText in a local UTF-8 file. Read the file first. Fails for missing or ambiguous matches.", parameters: { type: "object", additionalProperties: false, required: ["path", "oldText", "newText"], properties: { path: { type: "string", minLength: 1, maxLength: 4096 }, oldText: { type: "string", minLength: 1, maxLength: 500000 }, newText: { type: "string", maxLength: 500000 } } } },
  { name: "desktop_bash", effect: "write", description: "Run Bash on the user's desktop, starting in the selected directory. Requires native user approval for every command. Shell commands are NOT confined by the file-tool sandbox. Do not repeat uncertain writes. Windows requires Git Bash.", parameters: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string", minLength: 1, maxLength: 16000 }, timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 } } } },
];
export const LOCAL_TOOL_NAMES = localToolDefinitions.map(tool => tool.name);
export interface LocalToolRequest { id: string; name: string; input: unknown }
export type LocalToolResult = ToolResult;

/** Same closed schemas validated on the server and independently at the executor. */
export function validLocalInput(name: string, input: unknown): input is Record<string, string | number> {
  const definition = localToolDefinitions.find(tool => tool.name === name);
  if (!definition || !input || typeof input !== "object" || Array.isArray(input)) return false;
  const schema = definition.parameters as { required?: string[]; properties: Record<string, { type: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }> };
  const object = input as Record<string, unknown>;
  if (schema.required?.some(key => !Object.hasOwn(object, key))) return false;
  return Object.entries(object).every(([key, value]) => {
    const rule = schema.properties[key];
    if (!rule) return false;
    if (rule.type === "string") return typeof value === "string" && !value.includes("\0") && value.length >= (rule.minLength ?? 0) && value.length <= (rule.maxLength ?? Infinity);
    return typeof value === "number" && Number.isInteger(value) && value >= rule.minimum! && value <= rule.maximum!;
  });
}

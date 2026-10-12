import type { Tool, ToolResult } from "../types/index.js";

/** Transport-only definitions: this module never accesses the host machine. */
export const localToolDefinitions: Omit<Tool, "execute">[] = [
  { name: "desktop_list_files", effect: "read", description: "List entries in the user's selected desktop directory.", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string", maxLength: 4096 } } } },
  { name: "desktop_read_file", effect: "read", description: "Read a UTF-8 local file in the user's selected desktop directory (max 1 MB).", parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1, maxLength: 4096 } } } },
  { name: "desktop_write_file", effect: "write", description: "Create a new UTF-8 local file. Refuses to overwrite an existing file; use desktop_edit_file for changes. Parent directory must exist.", parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string", minLength: 1, maxLength: 4096 }, content: { type: "string", maxLength: 500000 } } } },
  { name: "desktop_edit_file", effect: "write", description: "Replace exactly one occurrence of oldText in a local UTF-8 file. Read the file first. Fails for missing or ambiguous matches.", parameters: { type: "object", additionalProperties: false, required: ["path", "oldText", "newText"], properties: { path: { type: "string", minLength: 1, maxLength: 4096 }, oldText: { type: "string", minLength: 1, maxLength: 500000 }, newText: { type: "string", maxLength: 500000 } } } },
  { name: "desktop_bash", effect: "write", description: "Run Bash on the user's macOS/Linux desktop, starting in the selected directory. Use Bash syntax. Subject to the user-selected approval policy. Commands are NOT confined by the file-tool sandbox. Do not repeat uncertain writes.", parameters: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string", minLength: 1, maxLength: 16000 }, timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 } } } },
  { name: "desktop_powershell", effect: "write", description: "Run built-in Windows PowerShell 5.1 on the user's Windows desktop, starting in the selected directory. Use PowerShell 5.1 syntax, NOT Bash: Get-ChildItem, Get-Content, etc.; no &&, Unix executables or Git required. Output is UTF-8. Subject to the user-selected approval policy. Commands are NOT confined by the file-tool sandbox. Prefer the dedicated file tools for reading, creating, editing and deleting files. Do not repeat uncertain writes.", parameters: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string", minLength: 1, maxLength: 10000 }, timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 } } } },
  { name: "desktop_delete_file", effect: "write", description: "Permanently delete one regular file inside the selected desktop directory, subject to the user's approval policy. Does not delete directories, follow links, or use a shell. Fails if the file changes during approval. Do not repeat uncertain writes.", parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1, maxLength: 4096 } } } },
];
export type LocalShell = "bash" | "powershell";
export interface LocalToolCapabilities { version: 2; shell: LocalShell | null }
/** Older clients only implement the original five tools. Never send them new operations. */
export function localToolsForClient(capabilities?: LocalToolCapabilities): Omit<Tool, "execute">[] {
  if (!capabilities) return localToolDefinitions.filter(tool => !["desktop_powershell", "desktop_delete_file"].includes(tool.name));
  return localToolDefinitions.filter(tool => !["desktop_bash", "desktop_powershell"].includes(tool.name) || tool.name === `desktop_${capabilities.shell}`);
}
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

import type { Tool, ToolResult } from "../types/index.js";

export function toolEffect(tool: Tool): "read" | "write" | "interaction" {
  return tool.effect ?? (tool.parallelSafe || tool.cacheable ? "read" : "write");
}

/** Preserve error semantics through domain wrappers and nested transport causes. */
export function classifyToolFailure(error: unknown, prefix: string): ToolResult {
  const chain: string[] = [];
  let cause: unknown = error;
  for (let i = 0; cause && i < 5; i++) {
    const e = cause as { name?: string; message?: string; code?: string; cause?: unknown };
    chain.push(`${e.name ?? ""} ${e.code ?? ""} ${e.message ?? String(cause)}`);
    cause = e.cause;
  }
  const text = chain.join(" ").toLowerCase();
  const errorKind = /timeout|timed out|etimedout/.test(text) ? "timeout"
    : /econn|fetch failed|network|socket|connection.*(closed|terminated|lost)/.test(text) ? "network"
    : /abort|cancelled|canceled/.test(text) ? "cancelled"
    : /enoent|not found|404/.test(text) ? "not_found"
    : /eperm|eacces|403|permission/.test(text) ? "permission"
    : /invalid|400|bad request/.test(text) ? "validation" : "unknown";
  return { content: `${prefix}: ${error instanceof Error ? error.message : "Service unavailable"}`, isError: true, errorKind };
}

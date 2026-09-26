import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, sep, dirname, basename } from "node:path";
import type { Tool, ToolContext, ToolResult, ToolErrorKind } from "../types/index.js";
import { askUserTool } from "./ask-user.js";
import { SsrfError } from "./net-guard.js";
import { fetchPublicBinary } from "./net-fetch.js";
import { runCommand } from "./process.js";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_LENGTH = 50_000;

function classifyFsError(error: unknown): { message: string; kind: ToolErrorKind } {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code ?? "";
  if (code === "ENOENT") return { message, kind: "not_found" };
  if (code === "EACCES" || code === "EPERM") return { message, kind: "permission" };
  return { message, kind: "unknown" };
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_LENGTH) return text;
  return (
    text.slice(0, MAX_OUTPUT_LENGTH) +
    `\n\n... (truncated, ${text.length} chars total)`
  );
}

function resolvePath(input: { path: string }, ctx: ToolContext): string {
  return resolve(ctx.workingDirectory, input.path);
}

/** True if `resolved` is the working directory or a path underneath it. */
function isContained(resolved: string, workingDirectory: string): boolean {
  return resolved === workingDirectory || resolved.startsWith(workingDirectory + sep);
}

/**
 * Resolves `path` through any symlinks. `path` itself may not exist yet (e.g.
 * a write_file target) — in that case, walks up to the nearest existing
 * ancestor, resolves *that* through symlinks, and re-appends the missing
 * suffix, since `fs.realpath` throws ENOENT on a non-existent path.
 */
async function resolveReal(path: string): Promise<string> {
  let suffix = "";
  let current = path;
  for (;;) {
    try {
      const real = await realpath(current);
      return suffix ? resolve(real, suffix) : real;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        // Non-ENOENT (e.g. EACCES) — fall back to the unresolved path and let
        // the actual fs operation surface the real error.
        return path;
      }
      const parent = dirname(current);
      if (parent === current) return path; // reached root without an existing ancestor
      suffix = suffix ? `${basename(current)}${sep}${suffix}` : basename(current);
      current = parent;
    }
  }
}

/**
 * Symlink-aware containment check: resolves both the working directory and
 * the target path through any symlinks before comparing, so a symlink that
 * lives inside the working directory but points outside of it (or the
 * working directory itself being reached via a symlink, e.g. macOS's
 * `/tmp` -> `/private/tmp`) can't be used to escape the sandbox. Callers
 * must also run the cheap string-based `isContained` first — this only
 * catches symlink indirection, not `..` segments (already resolved by `resolve()`).
 */
async function assertContainedReal(resolved: string, workingDirectory: string): Promise<boolean> {
  const [realWorkingDirectory, realResolved] = await Promise.all([
    resolveReal(workingDirectory),
    resolveReal(resolved),
  ]);
  return isContained(realResolved, realWorkingDirectory);
}

function escapeResult(path: string): ToolResult {
  return {
    content: `Path escapes the working directory: ${path}`,
    isError: true,
    errorKind: "permission",
  };
}

/**
 * Full containment check for a file tool: the cheap string check first (catches
 * `..` segments without any I/O), then the symlink-aware realpath check (catches
 * a symlink inside the working directory that points outside of it). Returns an
 * error ToolResult when containment fails, `undefined` when the path is safe.
 */
async function checkContainment(
  fullPath: string,
  path: string,
  workingDirectory: string
): Promise<ToolResult | undefined> {
  if (!isContained(fullPath, workingDirectory)) return escapeResult(path);
  if (!(await assertContainedReal(fullPath, workingDirectory))) return escapeResult(path);
  return undefined;
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns the file content as text.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file (relative to working directory)",
      },
    },
    required: ["path"],
  },
  async execute(input, context) {
    const { path } = input as { path: string };
    const fullPath = resolvePath({ path }, context);
    const escape = await checkContainment(fullPath, path, context.workingDirectory);
    if (escape) return escape;
    try {
      const content = await readFile(fullPath, "utf-8");
      return { content: truncate(content) };
    } catch (error) {
      return {
        content: `Failed to read file: ${error instanceof Error ? error.message : error}`,
        isError: true,
        errorKind: classifyFsError(error).kind,
      };
    }
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file. Creates the file if it doesn't exist.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file (relative to working directory)",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["path", "content"],
  },
  async execute(input, context) {
    const { path, content } = input as { path: string; content: string };
    const fullPath = resolvePath({ path }, context);
    const escape = await checkContainment(fullPath, path, context.workingDirectory);
    if (escape) return escape;
    try {
      await writeFile(fullPath, content, "utf-8");
      return { content: `Successfully wrote ${content.length} chars to ${path}` };
    } catch (error) {
      return {
        content: `Failed to write file: ${error instanceof Error ? error.message : error}`,
        isError: true,
        errorKind: classifyFsError(error).kind,
      };
    }
  },
};

export const listFilesTool: Tool = {
  name: "list_files",
  description:
    "List files and directories in a given path. Returns names with trailing / for directories.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Directory path to list (relative to working directory, default: '.')",
      },
    },
    required: [],
  },
  async execute(input, context) {
    const { path = "." } = (input as { path?: string }) ?? {};
    const fullPath = resolvePath({ path }, context);
    const escape = await checkContainment(fullPath, path, context.workingDirectory);
    if (escape) return escape;
    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      const lines = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return { content: lines.join("\n") || "(empty directory)" };
    } catch (error) {
      return {
        content: `Failed to list files: ${error instanceof Error ? error.message : error}`,
        isError: true,
        errorKind: classifyFsError(error).kind,
      };
    }
  },
};

export const executeCommandTool: Tool = {
  name: "execute_command",
  description:
    "Execute a shell command and return its output. Use with caution.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to execute",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Command arguments",
      },
    },
    required: ["command"],
  },
  async execute(input, context) {
    const { command, args = [] } = input as {
      command: string;
      args?: string[];
    };
    try {
      const { stdout, stderr } = await runCommand(command, args, {
        cwd: context.workingDirectory,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        signal: context.signal,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n");
      return { content: truncate(output) || "(no output)" };
    } catch (error: unknown) {
      const err = error as {
        message?: string;
        stdout?: string;
        stderr?: string;
        name?: string;
        code?: string;
      };
      if (err.name === "AbortError" || err.code === "ABORT_ERR") {
        return { content: "Command aborted", isError: true, errorKind: "unknown" };
      }
      return {
        content: truncate(
          `Command failed: ${err.message}\n${err.stdout ?? ""}\n${err.stderr ?? ""}`
        ),
        isError: true,
      };
    }
  },
};

export const searchFilesTool: Tool = {
  name: "search_files",
  description:
    "Search for a text pattern in files within a directory. Returns matching lines with file paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Text pattern to search for (plain text, not regex)",
      },
      path: {
        type: "string",
        description:
          "Directory to search in (relative to working directory, default: '.')",
      },
      extension: {
        type: "string",
        description: "Filter by file extension (e.g. '.ts', '.js')",
      },
    },
    required: ["pattern"],
  },
  async execute(input, context) {
    const { pattern, path = ".", extension } = input as {
      pattern: string;
      path?: string;
      extension?: string;
    };

    const fullPath = resolvePath({ path }, context);
    const escape = await checkContainment(fullPath, path, context.workingDirectory);
    if (escape) return escape;

    try {
      const { stdout } = await execFileAsync(
        "grep",
        [
          "-rn",
          "--include",
          extension ? `*${extension}` : "*",
          // `--` stops option parsing: without it, a pattern starting with `-`
          // (e.g. `-foo`) would be parsed by grep as a flag instead of the
          // search text, and rejected as "invalid option".
          "--",
          pattern,
          path,
        ],
        {
          cwd: context.workingDirectory,
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        }
      );
      return { content: truncate(stdout) || "No matches found" };
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      if (err.stdout) {
        return { content: truncate(err.stdout) || "No matches found" };
      }
      return {
        content: `Search failed: ${err.message}`,
        isError: true,
      };
    }
  },
};

// ── Web Tools ──

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function webFetchAllowHosts(): string[] {
  return (process.env.WEB_FETCH_ALLOW_HOSTS ?? "").split(",").map(h => h.trim()).filter(Boolean);
}

function networkFailure(error: unknown, prefix: string, signal?: AbortSignal): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number })?.status;
  const retryAfter = (error as { retryAfter?: string })?.retryAfter;
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const retryAfterMs = retryAfter
    ? Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()) : undefined;
  const errorKind: ToolErrorKind = signal?.aborted ? "cancelled"
    : error instanceof SsrfError ? "permission"
    : /timed? ?out|timeout/i.test(message) ? "timeout"
    : status === 429 || (status !== undefined && status >= 500) || /fetch failed|network|ECONN|ENOTFOUND|socket/i.test(message) ? "network"
    : status === 401 || status === 403 ? "permission"
    : status === 404 ? "not_found" : "unknown";
  return { content: `${prefix}: ${message}`, isError: true, errorKind,
    ...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}) };
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its text content. Useful for reading web pages, APIs, or documents.",
  // Pure external read — the same URL within a run yields the same content, so
  // an identical repeat call is reused instead of re-fetched.
  cacheable: true,
  retrySafe: true,
  execConfig: {
    timeoutMs: 20_000,
    retry: { maxRetries: 2, baseDelayMs: 2000, retryableKinds: ["timeout", "network"] },
  },
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch (must start with http:// or https://)",
      },
      maxChars: {
        type: "number",
        description: "Maximum characters to return (default: 20000)",
      },
    },
    required: ["url"],
  },
  async execute(input, context): Promise<ToolResult> {
    const { url, maxChars = 20000 } = input as {
      url: string;
      maxChars?: number;
    };

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { content: "URL must start with http:// or https://", isError: true };
    }

    // Consistent with execute_command/web_search: a run that's already
    // cancelled by the time this tool starts must not fire any request at all.
    if (context?.signal?.aborted) {
      return { content: "Fetch aborted", isError: true };
    }

    try {
      const downloaded = await fetchPublicBinary(url, {
        maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000, signal: context?.signal,
        allowHosts: webFetchAllowHosts(),
      });
      const contentType = downloaded.mime;
      const body = downloaded.body.toString("utf8");

      let text: string;
      if (contentType.includes("json")) {
        try {
          const parsed = JSON.parse(body);
          text = JSON.stringify(parsed, null, 2);
        } catch {
          text = body;
        }
      } else if (contentType.includes("html")) {
        text = htmlToText(body);
      } else {
        text = body;
      }

      if (text.length > maxChars) {
        text = text.slice(0, maxChars) + `\n\n... (truncated, ${text.length} chars total)`;
      }

      return { content: text || "(empty response)" };
    } catch (error) {
      return networkFailure(error, "Failed to fetch URL", context.signal);
    }
  },
};

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web using 智谱 BigModel web search. Returns results with titles, URLs, content, and publish dates. Use content directly — only fall back to web_fetch when content is empty but a link is present.",
  cacheable: false,
  retrySafe: true,
  execConfig: {
    timeoutMs: 20_000,
    retry: { maxRetries: 2, baseDelayMs: 2000, retryableKinds: ["timeout", "network"] },
  },
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query (max 70 characters)",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return (default: 10)",
      },
    },
    required: ["query"],
  },
  async execute(input, context): Promise<ToolResult> {
    const { query, maxResults = 5 } = input as {
      query: string;
      maxResults?: number;
    };

    const searchQuery = query.slice(0, 70);
    const requestId = randomUUID().replace(/-/g, "");
    const userId = (context.userId ?? "default").slice(0, 64);

    try {
      const res = await fetch("https://open.bigmodel.cn/api/paas/v4/web_search", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.BIGMODEL_API_KEY ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          search_query: searchQuery,
          search_engine: "search_pro",
          search_intent: false,
          count: maxResults,
          search_recency_filter: "oneWeek",
          request_id: requestId,
          user_id: userId,
        }),
        signal: context.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        return networkFailure(Object.assign(new Error(`HTTP ${res.status}${errBody ? ` - ${errBody.slice(0, 200)}` : ""}`), {
          status: res.status, retryAfter: res.headers.get("retry-after"),
        }), "Search failed", context.signal);
      }

      const data = (await res.json()) as {
        search_result?: {
          content: string;
          icon: string;
          link: string;
          media: string;
          publish_date: string;
          refer: string;
          title: string;
        }[];
      };

      const results = data.search_result ?? [];

      if (results.length === 0) {
        return { content: `No search results found for: ${query}` };
      }

      const formatted = results
        .slice(0, maxResults)
        .map((r, i) => {
          const parts: string[] = [];
          parts.push(`${i + 1}. ${r.title || "(no title)"}`);
          if (r.link) parts.push(`   URL: ${r.link}`);
          if (r.publish_date) parts.push(`   Date: ${r.publish_date}`);
          if (r.content) {
            parts.push(`   ${r.content}`);
          } else if (r.link) {
            parts.push(`   (content empty — use web_fetch to retrieve this page)`);
          } else {
            parts.push(`   (no content)`);
          }
          return parts.join("\n");
        })
        .join("\n\n");

      return { content: formatted };
    } catch (error) {
      return networkFailure(error, "Search failed", context.signal);
    }
  },
};

export function registerBuiltinTools(registry: {
  register(tool: Tool): void;
}, options: { includeHostTools?: boolean } = {}): void {
  if (options.includeHostTools !== false) {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(listFilesTool);
  registry.register(executeCommandTool);
  registry.register(searchFilesTool);
  }
  registry.register(webFetchTool);
  registry.register(webSearchTool);
  registry.register(askUserTool);
}

import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { Tool, ToolContext, ToolResult, ToolErrorKind } from "../types/index.js";
import { askUserTool } from "./ask-user.js";
import { assertPublicUrl } from "./net-guard.js";

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
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: context.workingDirectory,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n");
      return { content: truncate(output) || "(no output)" };
    } catch (error: unknown) {
      const err = error as { message?: string; stdout?: string; stderr?: string };
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

    try {
      const { stdout } = await execFileAsync(
        "grep",
        [
          "-rn",
          "--include",
          extension ? `*${extension}` : "*",
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

const MAX_REDIRECTS = 3;

function webFetchAllowHosts(): string[] {
  return (process.env.WEB_FETCH_ALLOW_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  redirect: RequestRedirect = "follow"
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; LotAgent/0.1; +https://github.com/lot-agent)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches `url`, re-checking the SSRF guard on every hop of up to
 * `MAX_REDIRECTS` manual redirects (a same-origin-looking redirect to an
 * internal address is the classic SSRF bypass — following redirects
 * automatically would skip the guard on the final, real destination).
 */
async function fetchPublic(url: string, timeoutMs: number): Promise<Response> {
  let currentUrl = url;
  const allowHosts = webFetchAllowHosts();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(currentUrl, { allowHosts });
    const res = await fetchWithTimeout(currentUrl, timeoutMs, "manual");
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === MAX_REDIRECTS) {
        throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new Error("unreachable");
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its text content. Useful for reading web pages, APIs, or documents.",
  // Pure external read — the same URL within a run yields the same content, so
  // an identical repeat call is reused instead of re-fetched.
  cacheable: true,
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
  async execute(input): Promise<ToolResult> {
    const { url, maxChars = 20000 } = input as {
      url: string;
      maxChars?: number;
    };

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { content: "URL must start with http:// or https://", isError: true };
    }

    try {
      const res = await fetchPublic(url, 15_000);
      if (!res.ok) {
        return {
          content: `HTTP ${res.status}: ${res.statusText}`,
          isError: true,
        };
      }

      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();

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
      const msg =
        error instanceof Error ? error.message : String(error);
      return {
        content: `Failed to fetch URL: ${msg}`,
        isError: true,
      };
    }
  },
};

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web using 智谱 BigModel web search. Returns results with titles, URLs, content, and publish dates. Use content directly — only fall back to web_fetch when content is empty but a link is present.",
  cacheable: false,
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
        return {
          content: `Search failed: HTTP ${res.status}${errBody ? ` - ${errBody.slice(0, 200)}` : ""}`,
          isError: true,
        };
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
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: `Search failed: ${msg}`,
        isError: true,
      };
    }
  },
};

export function registerBuiltinTools(registry: {
  register(tool: Tool): void;
}): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(listFilesTool);
  registry.register(executeCommandTool);
  registry.register(searchFilesTool);
  registry.register(webFetchTool);
  registry.register(webSearchTool);
  registry.register(askUserTool);
}

import { readFile, writeFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types/index.js";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_LENGTH = 50_000;

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

async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
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

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its text content. Useful for reading web pages, APIs, or documents.",
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
      const res = await fetchWithTimeout(url, 15_000);
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
    "Search the web using DuckDuckGo. Returns a list of search results with titles, URLs, and snippets.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return (default: 5)",
      },
    },
    required: ["query"],
  },
  async execute(input): Promise<ToolResult> {
    const { query, maxResults = 5 } = input as {
      query: string;
      maxResults?: number;
    };

    try {
      // Use DuckDuckGo HTML search (no API key needed)
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetchWithTimeout(searchUrl, 15_000);
      if (!res.ok) {
        return {
          content: `Search failed: HTTP ${res.status}`,
          isError: true,
        };
      }

      const html = await res.text();

      // Parse results from DuckDuckGo HTML
      const results: { title: string; url: string; snippet: string }[] = [];

      // Match result blocks
      const resultRegex =
        /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

      let match;
      while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
        const url = match[1];
        const title = htmlToText(match[2]);
        const snippet = htmlToText(match[3]);
        if (title && url) {
          results.push({ title, url, snippet });
        }
      }

      if (results.length === 0) {
        // Fallback: try simpler regex
        const simpleRegex =
          /<a[^>]+rel="nofollow"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        while (
          (match = simpleRegex.exec(html)) !== null &&
          results.length < maxResults
        ) {
          const url = match[1];
          const title = htmlToText(match[2]);
          if (title && url && !url.includes("duckduckgo")) {
            results.push({ title, url, snippet: "" });
          }
        }
      }

      if (results.length === 0) {
        return { content: "No search results found for: " + query };
      }

      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
        )
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
}

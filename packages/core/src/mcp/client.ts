import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool, ToolResult, ToolContext } from "../types/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { retryAsync } from "./retry.js";
import { logger } from "../logger/log.js";

const log = logger.child({ mod: "mcp" });

export interface MCPConfig {
  id: string;
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
  /** Auth/custom headers for remote (sse / streamable-http) transports. */
  headers?: Record<string, string>;
}

interface MCPServerEntry {
  config: MCPConfig;
  client: Client;
  tools: Tool[];
}

const CONNECT_TIMEOUT_MS = 30_000;

export class MCPClientManager {
  private servers = new Map<string, MCPServerEntry>();

  /** Build a fresh transport for one connect attempt (not reusable after failure). */
  private buildTransport(config: MCPConfig) {
    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error(`MCP server ${config.id}: command is required for stdio`);
      }
      return new StdioClientTransport({ command: config.command, args: config.args });
    }
    if (config.transport === "sse") {
      if (!config.url) {
        throw new Error(`MCP server ${config.id}: url is required for sse`);
      }
      return new SSEClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    }
    if (config.transport === "streamable-http") {
      if (!config.url) {
        throw new Error(`MCP server ${config.id}: url is required for streamable-http`);
      }
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    }
    throw new Error(`Unsupported transport: ${config.transport}`);
  }

  async connect(config: MCPConfig): Promise<void> {
    const client = new Client(
      { name: "lot-agent", version: "0.1.0" },
      { capabilities: {} }
    );

    // Connect with a per-attempt timeout, closing the transport on failure so
    // a timed-out connection doesn't leak, and retrying with exponential
    // backoff (up to 3 attempts).
    await retryAsync(
      async () => {
        const transport = this.buildTransport(config);
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`MCP connect timeout (${CONNECT_TIMEOUT_MS}ms)`)),
              CONNECT_TIMEOUT_MS
            );
          });
          try {
            await Promise.race([client.connect(transport), timeout]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        } catch (err) {
          // Ensure the half-open transport is torn down before the next try.
          await transport.close().catch(() => {});
          throw err;
        }
      },
      {
        attempts: 3,
        onRetry: (attempt, err) =>
          log.warn("MCP connect failed, retrying", {
            server: config.id,
            attempt,
            err: err as Error,
          }),
      }
    );

    // Discover tools
    const { tools: mcpTools } = await client.listTools();
    const tools: Tool[] = mcpTools.map((t) => ({
      name: `${config.id}__${t.name}`,
      description: t.description ?? "",
      parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      // Remote calls: bound each with a timeout; never dedup-cache (an MCP tool
      // may have side effects and its result can change between calls).
      execConfig: { timeoutMs: CONNECT_TIMEOUT_MS },
      cacheable: false,
      execute: async (input: unknown, _ctx: ToolContext): Promise<ToolResult> => {
        try {
          const result = await client.callTool({
            name: t.name,
            arguments: input as Record<string, unknown>,
          });
          const content = Array.isArray(result.content)
            ? result.content
                .map((c: { type: string; text?: string }) =>
                  c.type === "text" ? c.text ?? "" : JSON.stringify(c)
                )
                .join("\n")
            : String(result.content);
          return { content, isError: result.isError as boolean | undefined };
        } catch (error) {
          return {
            content: `MCP tool error: ${error instanceof Error ? error.message : error}`,
            isError: true,
          };
        }
      },
    }));

    this.servers.set(config.id, { config, client, tools });
  }

  async disconnect(serverId: string): Promise<void> {
    const entry = this.servers.get(serverId);
    if (!entry) return;
    await entry.client.close();
    this.servers.delete(serverId);
  }

  async disconnectAll(): Promise<void> {
    for (const id of this.servers.keys()) {
      await this.disconnect(id);
    }
  }

  getTools(): Tool[] {
    const tools: Tool[] = [];
    for (const entry of this.servers.values()) {
      tools.push(...entry.tools);
    }
    return tools;
  }

  registerTools(registry: ToolRegistry): void {
    for (const tool of this.getTools()) {
      registry.register(tool);
    }
  }

  getServerIds(): string[] {
    return [...this.servers.keys()];
  }
}

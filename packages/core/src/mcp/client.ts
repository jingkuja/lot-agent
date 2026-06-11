import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool, ToolResult, ToolContext } from "../types/index.js";
import { ToolRegistry } from "../tools/registry.js";

export interface MCPConfig {
  id: string;
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
}

interface MCPServerEntry {
  config: MCPConfig;
  client: Client;
  tools: Tool[];
}

const CONNECT_TIMEOUT_MS = 30_000;

export class MCPClientManager {
  private servers = new Map<string, MCPServerEntry>();

  async connect(config: MCPConfig): Promise<void> {
    let transport;

    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error(`MCP server ${config.id}: command is required for stdio`);
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
      });
    } else if (config.transport === "sse") {
      if (!config.url) {
        throw new Error(`MCP server ${config.id}: url is required for sse`);
      }
      transport = new SSEClientTransport(new URL(config.url));
    } else if (config.transport === "streamable-http") {
      if (!config.url) {
        throw new Error(`MCP server ${config.id}: url is required for streamable-http`);
      }
      transport = new StreamableHTTPClientTransport(new URL(config.url));
    } else {
      throw new Error(`Unsupported transport: ${config.transport}`);
    }

    const client = new Client(
      { name: "lot-agent", version: "0.1.0" },
      { capabilities: {} }
    );

    // Connect with timeout
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`MCP connect timeout (${CONNECT_TIMEOUT_MS}ms)`)),
          CONNECT_TIMEOUT_MS
        )
      ),
    ]);

    // Discover tools
    const { tools: mcpTools } = await client.listTools();
    const tools: Tool[] = mcpTools.map((t) => ({
      name: `${config.id}__${t.name}`,
      description: t.description ?? "",
      parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
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

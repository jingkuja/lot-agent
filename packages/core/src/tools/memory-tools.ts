import type { Tool, ToolResult, ToolContext } from "../types/index.js";

/**
 * Create memory tools that use per-request memory from context.
 * Each tool reads `context.memory` at call time — no closure capture.
 */
export function createMemoryTools(): Tool[] {
  const memoryRead: Tool = {
    name: "memory_read",
    description:
      "Read a value from memory by key. Use tier='session' for temporary data, tier='user' for persistent preferences.",
    parameters: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          enum: ["ephemeral", "session", "user"],
          description: "Memory tier to read from",
        },
        key: {
          type: "string",
          description: "The memory key to read",
        },
      },
      required: ["tier", "key"],
    },
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const memory = context.memory;
      if (!memory) return { content: "Memory not available", isError: true };
      const { tier, key } = input as { tier: string; key: string };
      if (tier === "user") {
        const value = await memory.getUserMemory(key);
        if (value === undefined) {
          return { content: `Key '${key}' not found in user memory` };
        }
        return { content: value };
      }
      const value = memory.get(tier as "ephemeral" | "session", key);
      if (value === undefined) {
        return { content: `Key '${key}' not found in ${tier} memory` };
      }
      return { content: value };
    },
  };

  const memoryWrite: Tool = {
    name: "memory_write",
    description:
      "Write a value to memory. Use tier='session' for temporary (20min), tier='user' for permanent user preferences/facts.",
    parameters: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          enum: ["ephemeral", "session", "user"],
          description: "Memory tier to write to",
        },
        key: {
          type: "string",
          description: "The memory key",
        },
        value: {
          type: "string",
          description: "The value to store",
        },
      },
      required: ["tier", "key", "value"],
    },
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const memory = context.memory;
      if (!memory) return { content: "Memory not available", isError: true };
      const { tier, key, value } = input as {
        tier: string;
        key: string;
        value: string;
      };
      if (tier === "user") {
        await memory.setUserMemory(key, value);
        return { content: `Saved to user memory: ${key}` };
      }
      memory.set(tier as "ephemeral" | "session", key, value);
      return { content: `Saved to ${tier} memory: ${key}` };
    },
  };

  const memoryList: Tool = {
    name: "memory_list",
    description:
      "List all keys in a memory tier. Use to see what's stored.",
    parameters: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          enum: ["ephemeral", "session", "user"],
          description: "Memory tier to list",
        },
      },
      required: ["tier"],
    },
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const memory = context.memory;
      if (!memory) return { content: "Memory not available", isError: true };
      const { tier } = input as { tier: string };
      if (tier === "user") {
        const entries = await memory.listUserMemory();
        if (entries.length === 0) {
          return { content: "No user memories stored" };
        }
        return {
          content: entries.map((e) => `${e.key}: ${e.value}`).join("\n"),
        };
      }
      const entries = memory.dump(tier as "ephemeral" | "session");
      if (entries.length === 0) {
        return { content: `No ${tier} memories stored` };
      }
      return {
        content: entries.map((e) => `${e.key}: ${e.value}`).join("\n"),
      };
    },
  };

  return [memoryRead, memoryWrite, memoryList];
}

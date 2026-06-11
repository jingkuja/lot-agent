import type { Tool, LLMTool, ToolResult, ToolContext } from "../types/index.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  toLLMTools(): LLMTool[] {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  async execute(
    name: string,
    input: unknown,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `Tool not found: ${name}`, isError: true };
    }
    try {
      return await tool.execute(input, context);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return { content: `Tool execution error: ${message}`, isError: true };
    }
  }
}

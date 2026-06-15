import type {
  Message,
  LLMProvider,
  ToolCall,
  ToolContext,
} from "../types/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { ContextManager, type ContextManagerConfig } from "../context/index.js";

/** Events emitted during agent execution */
export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  | { type: "done"; iterations: number; totalTokens: number }
  | { type: "error"; message: string };

export interface AgentConfig {
  maxIterations: number;
  systemPrompt: string;
  dynamicPromptParts?: string[];
  contextConfig?: ContextManagerConfig;
}

export interface AgentContext {
  llm: LLMProvider;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
}

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 20,
  systemPrompt: "You are a helpful AI assistant.",
};

export class Agent {
  private config: AgentConfig;
  private contextManager: ContextManager;

  constructor(config: Partial<AgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.contextManager = new ContextManager(this.config.contextConfig);
  }

  async *run(
    userMessage: string,
    context: AgentContext,
    history: Message[] = []
  ): AsyncIterable<AgentEvent> {
    // Build system prompt parts
    const systemParts = [this.config.systemPrompt];
    if (this.config.dynamicPromptParts?.length) {
      systemParts.push(...this.config.dynamicPromptParts);
    }

    const tools = context.toolRegistry.toLLMTools();
    let iterations = 0;
    let totalTokens = 0;

    // Working message log (accumulates during this run)
    const workingHistory: Message[] = [...history];

    while (iterations < this.config.maxIterations) {
      iterations++;
      let hasToolCalls = false;
      let assistantContent = "";
      const toolCalls: ToolCall[] = [];

      // Assemble messages with context management (budget + sliding window + summary)
      const messages = await this.contextManager.assemble(
        systemParts,
        undefined, // memory — could be wired to a memory store
        workingHistory,
        { role: "user", content: userMessage },
        context.llm  // use same LLM as compressor for summaries
      );

      // Stream LLM response
      for await (const chunk of context.llm.chat(messages, tools)) {
        if (chunk.type === "text" && chunk.content) {
          assistantContent += chunk.content;
          yield { type: "text", content: chunk.content };
        }
        if (chunk.type === "tool_call" && chunk.toolCall) {
          hasToolCalls = true;
          toolCalls.push(chunk.toolCall);
        }
        if (chunk.type === "done" && chunk.usage) {
          totalTokens +=
            chunk.usage.promptTokens + chunk.usage.completionTokens;
        }
      }

      // If no tool calls, agent is done
      if (!hasToolCalls) {
        yield { type: "done", iterations, totalTokens };
        return;
      }

      // Record assistant message with tool calls
      const assistantMsg: Message = {
        role: "assistant",
        content: assistantContent || "",
        toolCalls,
      };
      workingHistory.push(assistantMsg);

      // Execute all tool calls
      for (const tc of toolCalls) {
        yield {
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        };

        const result = await context.toolRegistry.execute(
          tc.name,
          tc.arguments,
          context.toolContext
        );

        yield {
          type: "tool_result",
          name: tc.name,
          output: result.content,
          isError: result.isError ?? false,
        };

        // Add tool result to working history
        workingHistory.push({
          role: "tool",
          content: result.content,
          toolCallId: tc.id,
        });
      }
    }

    // Max iterations reached
    yield {
      type: "error",
      message: `Reached maximum iterations (${this.config.maxIterations})`,
    };
    yield { type: "done", iterations, totalTokens };
  }
}

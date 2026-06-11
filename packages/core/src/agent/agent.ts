import type {
  Message,
  LLMProvider,
  ToolCall,
  ToolContext,
} from "../types/index.js";
import { ToolRegistry } from "../tools/registry.js";

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

  constructor(config: Partial<AgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async *run(
    userMessage: string,
    context: AgentContext,
    history: Message[] = []
  ): AsyncIterable<AgentEvent> {
    const messages: Message[] = [];

    // Build system prompt
    const systemParts = [this.config.systemPrompt];
    if (this.config.dynamicPromptParts?.length) {
      systemParts.push(...this.config.dynamicPromptParts);
    }
    messages.push({ role: "system", content: systemParts.join("\n\n") });

    // Add conversation history
    messages.push(...history);

    // Add current user message
    messages.push({ role: "user", content: userMessage });

    const tools = context.toolRegistry.toLLMTools();
    let iterations = 0;
    let totalTokens = 0;

    while (iterations < this.config.maxIterations) {
      iterations++;
      let hasToolCalls = false;
      let assistantContent = "";
      const toolCalls: ToolCall[] = [];

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
      messages.push({
        role: "assistant",
        content: assistantContent || "",
        toolCalls,
      });

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

        // Add tool result to messages
        messages.push({
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

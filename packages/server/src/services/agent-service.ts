import { randomUUID } from "node:crypto";
import {
  Agent,
  ToolRegistry,
  registerBuiltinTools,
  createMemoryTools,
  createLLMProvider,
  TraceManager,
  ConsoleSink,
  SkillLoader,
  MCPClientManager,
  loadMCPConfig,
  AgentMemoryStore,
  PgMemoryAdapter,
  InMemoryAgentRegistry,
  copywritingDefinition,
  imageDefinition,
  videoDefinition,
  InMemoryModelRegistry,
  populateModelRegistry,
} from "@lot-agent/core";
import type {
  AgentEvent,
  AgentConfig,
  AgentContext,
  Message,
  LLMConfig,
  LLMProvider,
  AgentDefinition,
  ModelConfig,
  JobQueue,
} from "@lot-agent/core";
import { DB } from "../db/database.js";
import { createRedisConnection } from "../jobs/redis.js";
import { BullmqJobQueue } from "../jobs/bullmq-queue.js";

export interface ServiceConfig {
  llm: LLMConfig;
  models: ModelConfig[];
  agent: Partial<AgentConfig>;
  mcpConfigPath: string;
  skillsDir: string;
  db?: {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  };
}

export class AgentService {
  readonly db: DB;
  readonly traceManager: TraceManager;
  readonly toolRegistry: ToolRegistry;
  readonly skillLoader: SkillLoader;
  readonly mcpManager: MCPClientManager;
  readonly memory: AgentMemoryStore;
  readonly agentRegistry: InMemoryAgentRegistry;
  readonly modelRegistry: InMemoryModelRegistry;
  jobQueue!: JobQueue;
  private llmConfig: LLMConfig;
  private configModels: ModelConfig[];
  private agentConfig: Partial<AgentConfig>;
  private mcpConfigPath: string;
  private skillsDir: string;
  private llmProvider: LLMProvider | null = null;
  private bullmqQueue: BullmqJobQueue | null = null;

  constructor(config: ServiceConfig) {
    this.db = new DB(config.db);
    this.traceManager = new TraceManager();
    this.traceManager.addSink(new ConsoleSink());
    this.toolRegistry = new ToolRegistry();
    this.skillLoader = new SkillLoader();
    this.memory = new AgentMemoryStore();
    this.mcpManager = new MCPClientManager();
    this.agentRegistry = new InMemoryAgentRegistry();
    this.modelRegistry = new InMemoryModelRegistry();
    this.llmConfig = config.llm;
    this.configModels = config.models;
    this.agentConfig = config.agent;
    this.mcpConfigPath = config.mcpConfigPath;
    this.skillsDir = config.skillsDir;
  }

  async init(): Promise<void> {
    // Initialize database (runs migration)
    await this.db.init();

    // Initialize job queue (server enqueues; separate Worker process consumes)
    const conn = createRedisConnection(process.env.REDIS_URL);
    this.bullmqQueue = new BullmqJobQueue(this.db, conn);
    this.jobQueue = this.bullmqQueue;

    // Initialize persistent user memory
    const pgAdapter = new PgMemoryAdapter(this.db.pool);
    await pgAdapter.init();
    this.memory = new AgentMemoryStore({
      persistent: pgAdapter,
      userId: "default", // single-user mode for now
    });

    registerBuiltinTools(this.toolRegistry);

    // Register memory tools
    for (const tool of createMemoryTools(this.memory)) {
      this.toolRegistry.register(tool);
    }

    // Load skills
    await this.skillLoader.loadFromDirectory(this.skillsDir);
    console.log(`Loaded ${this.skillLoader.getSkills().length} skills`);

    // Connect MCP servers (non-fatal if fails)
    try {
      const mcpConfigs = await loadMCPConfig(this.mcpConfigPath);
      for (const cfg of mcpConfigs) {
        try {
          await this.mcpManager.connect(cfg);
          console.log(`Connected MCP server: ${cfg.name}`);
        } catch (error) {
          console.warn(`Failed to connect MCP server ${cfg.name}:`, error);
        }
      }
      this.mcpManager.registerTools(this.toolRegistry);
    } catch {
      // No MCP config file, skip
    }

    console.log(`Registered ${this.toolRegistry.getAll().length} tools`);

    // Populate model registry with all configured models
    populateModelRegistry(this.modelRegistry, this.configModels, this.llmConfig);

    // Register agent definitions after all tools are loaded
    const defaultModelId =
      this.llmConfig.default === "openai"
        ? this.llmConfig.openai.model
        : this.llmConfig.anthropic.model;

    const generalDef: AgentDefinition = {
      id: "general",
      name: "通用助手",
      type: "general",
      description: "通用任务助手",
      systemPrompt: this.agentConfig.systemPrompt ?? "You are a helpful AI assistant.",
      toolNames: this.toolRegistry.getAll().map((t) => t.name),
      defaultModelId,
    };
    this.agentRegistry.register(generalDef);
    this.agentRegistry.register(copywritingDefinition);
    this.agentRegistry.register(imageDefinition);
    this.agentRegistry.register(videoDefinition);
  }

  private getLLMProvider(): import("@lot-agent/core").LLMProvider {
    if (!this.llmProvider) {
      this.llmProvider = createLLMProvider(this.llmConfig);
    }
    return this.llmProvider;
  }

  private async generateTitle(
    conversationId: string,
    userMessage: string
  ): Promise<void> {
    try {
      const conversation = await this.db.getConversation(conversationId);
      if (!conversation || conversation.title !== "New Chat") return;

      // Count user messages — only generate title on first user message
      const messages = await this.db.getMessages(conversationId);
      const userMsgCount = messages.filter((m) => m.role === "user").length;
      if (userMsgCount > 1) return;

      const llm = this.getLLMProvider();
      let title = "";
      for await (const chunk of llm.chat([
        {
          role: "system",
          content:
            'Generate a short title (max 30 chars) for this conversation based on the user message. Reply with ONLY the title, no quotes, no punctuation at the end.',
        },
        { role: "user", content: userMessage },
      ])) {
        if (chunk.type === "text") title += chunk.content;
      }

      title = title.trim().replace(/^["']|["']$/g, "").slice(0, 50);
      if (title) {
        await this.db.updateConversationTitle(conversationId, title);
      }
    } catch (error) {
      console.warn("Failed to generate title:", error);
    }
  }

  async *streamAgentResponse(
    conversationId: string,
    userMessage: string,
    agentId?: string
  ): AsyncIterable<AgentEvent> {
    const def =
      this.agentRegistry.get(agentId ?? "general") ??
      this.agentRegistry.get("general")!;
    // Save user message
    const userMsgId = randomUUID();
    await this.db.addMessage(userMsgId, conversationId, "user", userMessage);

    // Load conversation history
    const stored = await this.db.getMessages(conversationId);
    const filtered = stored.filter(
      (m) => m.role !== "user" || m.id !== userMsgId
    );

    // Collect all tool_call_ids that are referenced by assistant messages
    const validToolCallIds = new Set<string>();
    for (const m of filtered) {
      if (m.role === "assistant" && m.tool_calls) {
        try {
          const calls = JSON.parse(m.tool_calls) as { id: string }[];
          for (const tc of calls) {
            if (tc.id) validToolCallIds.add(tc.id);
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    // Filter out orphan tool messages (no matching assistant tool_call)
    const history: Message[] = [];
    for (const m of filtered) {
      if (m.role === "tool" && m.tool_call_id) {
        if (!validToolCallIds.has(m.tool_call_id)) continue; // orphan — skip
      }
      history.push({
        role: m.role as Message["role"],
        content: m.content,
        toolCallId: m.tool_call_id ?? undefined,
      });
    }

    // Match skills
    const matchedSkills = this.skillLoader.match(userMessage);
    const dynamicParts = matchedSkills.map(
      (s) => `[Skill: ${s.name}]\n${s.content}`
    );

    const llm = this.modelRegistry.getProvider<LLMProvider>(def.defaultModelId) ?? this.getLLMProvider();
    const agentConfig = this.agentConfig as Record<string, unknown>;
    const contextConfig = agentConfig.context as import("@lot-agent/core").ContextManagerConfig | undefined;
    const agent = new Agent({
      ...this.agentConfig,
      systemPrompt: def.systemPrompt,
      allowedToolNames: def.toolNames,
      dynamicPromptParts: dynamicParts,
      contextConfig: contextConfig
        ? { ...contextConfig, compressor: llm }
        : undefined,
    });

    // Create trace
    const trace = this.traceManager.startTrace(
      conversationId,
      this.llmConfig.default
    );

    const context: AgentContext = {
      llm,
      toolRegistry: this.toolRegistry,
      toolContext: { workingDirectory: process.cwd() },
      memory: this.memory,
    };

    let assistantContent = "";
    let currentToolCalls: { id: string; name: string; arguments: unknown }[] = [];
    let totalTokens = 0;
    let hasError = false;
    let llmSpanId: string | undefined;
    let toolSpanId: string | undefined;
    let requestStart = Date.now();

    try {
      for await (const event of agent.run(userMessage, context, history)) {
        if (event.type === "text") {
          if (!llmSpanId) {
            llmSpanId = this.traceManager.startSpan(trace.id, "llm.chat").id;
          }
          assistantContent += event.content;
        }

        if (event.type === "tool_call") {
          if (llmSpanId) {
            this.traceManager.endSpan(llmSpanId);
            llmSpanId = undefined;
          }

          toolSpanId = this.traceManager.startSpan(
            trace.id,
            "tool.execute",
            undefined,
            { toolName: event.name }
          ).id;

          currentToolCalls.push({
            id: event.id,
            name: event.name,
            arguments: event.input,
          });
        }

        if (event.type === "tool_result") {
          if (toolSpanId) {
            this.traceManager.endSpan(toolSpanId, event.isError ? "error" : "ok");
            toolSpanId = undefined;
          }

          const matchingCall = currentToolCalls.find(
            (tc) => tc.name === event.name
          );

          if (currentToolCalls.length > 0) {
            // Save assistant message with tool calls
            const assistantMsgId = randomUUID();
            await this.db.addMessage(
              assistantMsgId,
              conversationId,
              "assistant",
              assistantContent || "",
              { toolCallId: undefined }
            );

            // Save tool call records
            for (const tc of currentToolCalls) {
              await this.db.addToolCall(
                assistantMsgId,
                tc.id,
                tc.name,
                tc.arguments
              );
            }

            // Save tool result
            await this.db.addMessage(
              randomUUID(),
              conversationId,
              "tool",
              event.output,
              { toolCallId: matchingCall?.id }
            );

            assistantContent = "";
            currentToolCalls = [];
          }
        }

        if (event.type === "done") {
          totalTokens = event.totalTokens;
        }

        if (event.type === "error") {
          hasError = true;
        }

        yield event;
      }
    } finally {
      if (llmSpanId) this.traceManager.endSpan(llmSpanId);
      if (toolSpanId) this.traceManager.endSpan(toolSpanId);

      // Save final assistant message
      if (assistantContent || currentToolCalls.length > 0) {
        const assistantMsgId = randomUUID();
        await this.db.addMessage(
          assistantMsgId,
          conversationId,
          "assistant",
          assistantContent || ""
        );
        for (const tc of currentToolCalls) {
          await this.db.addToolCall(
            assistantMsgId,
            tc.id,
            tc.name,
            tc.arguments
          );
        }
      }

      // Save trace
      const latencyMs = Date.now() - requestStart;
      trace.metadata.totalTokens = totalTokens;
      if (hasError) {
        (trace.metadata as Record<string, unknown>).status = "error";
      }
      this.traceManager.endTrace(trace.id);

      await this.db.addTrace({
        id: trace.id,
        conversation_id: conversationId,
        model: this.llmConfig.default === "openai"
          ? this.llmConfig.openai.model
          : this.llmConfig.anthropic.model,
        provider: this.llmConfig.default,
        total_tokens: totalTokens,
        total_latency_ms: latencyMs,
        status: hasError ? "error" : "ok",
        error_message: hasError ? "Max iterations reached" : undefined,
        metadata: trace.metadata as Record<string, unknown>,
      });

      for (const span of trace.spans) {
        await this.db.addSpan({
          id: span.id,
          trace_id: trace.id,
          parent_span_id: span.parentSpanId,
          name: span.name,
          status: span.status,
          attributes: span.attributes,
          events: span.events,
          start_time: new Date(span.startTime).toISOString(),
          end_time: span.endTime ? new Date(span.endTime).toISOString() : undefined,
        });
      }

      // Generate title from first user message (async, non-blocking)
      this.generateTitle(conversationId, userMessage);
    }
  }

  async shutdown(): Promise<void> {
    await this.mcpManager.disconnectAll();
    if (this.bullmqQueue) {
      await this.bullmqQueue.close();
    }
    await this.db.close();
  }
}

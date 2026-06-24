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
  KeywordReviewProvider,
  XiaohongshuConnector,
  WechatMpConnector,
  LocalStorage,
} from "@lot-agent/core";
import { dirname, resolve } from "node:path";
import { createDocTool } from "../tools/doc-tool.js";
import type {
  AgentEvent,
  AgentConfig,
  AgentContext,
  LLMConfig,
  LLMProvider,
  AgentDefinition,
  ModelConfig,
  JobQueue,
  ReviewProvider,
  PlatformConnector,
  ContentPart,
} from "@lot-agent/core";
import { extractAttachment, type AttachmentRef } from "./attachment-extractor.js";
import { DB } from "../db/database.js";
import { SessionStore } from "../auth/session-store.js";
import { createRedisConnection } from "../jobs/redis.js";
import { BullmqJobQueue } from "../jobs/bullmq-queue.js";
import { UsageMeter } from "../billing/meter.js";
import { MessageRepository } from "./message-repository.js";
import { TraceRecorder } from "./trace-recorder.js";

/**
 * Builtin tools that touch the host filesystem / shell. On the deployed
 * BS-architecture box these are kept registered (so they can be re-enabled by
 * editing this set) but are NOT exposed to the agent. Only the web tools (and
 * the doc-generation tool, which runs a sandboxed Python script) stay loaded.
 */
const DISABLED_HOST_TOOLS = new Set([
  "read_file",
  "write_file",
  "list_files",
  "search_files",
  "execute_command",
]);

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
  readonly agentRegistry: InMemoryAgentRegistry;
  readonly modelRegistry: InMemoryModelRegistry;
  readonly reviewProvider: ReviewProvider;
  readonly connectors: Map<string, PlatformConnector>;
  /** Persistent memory adapter — kept for per-request AgentMemoryStore construction */
  pgAdapter!: import("@lot-agent/core").PgMemoryAdapter;
  /** Session store for multi-user auth */
  sessions!: SessionStore;
  jobQueue!: JobQueue;
  usageMeter!: UsageMeter;
  /** Storage for user-uploaded files, served at /static/uploads (separate from generated assets). */
  uploadStorage!: LocalStorage;
  private llmConfig: LLMConfig;
  private configModels: ModelConfig[];
  private agentConfig: Partial<AgentConfig>;
  private mcpConfigPath: string;
  private skillsDir: string;
  private llmProvider: LLMProvider | null = null;
  private bullmqQueue: BullmqJobQueue | null = null;
  private messageRepo!: MessageRepository;
  private traceRecorderFactory!: () => TraceRecorder;

  constructor(config: ServiceConfig) {
    this.db = new DB(config.db);
    this.traceManager = new TraceManager();
    this.traceManager.addSink(new ConsoleSink());
    this.toolRegistry = new ToolRegistry();
    this.skillLoader = new SkillLoader();
    this.mcpManager = new MCPClientManager();
    this.agentRegistry = new InMemoryAgentRegistry();
    this.modelRegistry = new InMemoryModelRegistry();
    this.reviewProvider = new KeywordReviewProvider();
    this.connectors = new Map([
      ["xiaohongshu", new XiaohongshuConnector()],
      ["wechat_mp", new WechatMpConnector()],
    ]);
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

    // Initialize persistent user memory adapter (shared; per-request stores created in streamAgentResponse)
    const pgAdapter = new PgMemoryAdapter(this.db.pool);
    await pgAdapter.init();
    this.pgAdapter = pgAdapter;

    // Initialize session store
    this.sessions = new SessionStore(this.db);

    registerBuiltinTools(this.toolRegistry);

    // Register memory tools — no closure capture; each tool reads context.memory at call time
    for (const tool of createMemoryTools()) {
      this.toolRegistry.register(tool);
    }

    // Register the document-generation tool. It runs a sandboxed Python script
    // (shared venv under data/skills-env) and persists output to its own
    // storage (data/documents, served at /static/documents) — kept separate
    // from data/assets, which is reserved for image/video generation material.
    // Stays usable even though execute_command is disabled on the box.
    const root = dirname(this.skillsDir);

    // 用户上传文件的独立存储，服务于 /static/uploads（与 data/assets 生成物分开）
    this.uploadStorage = new LocalStorage(resolve(root, "data/uploads"), "/static/uploads");

    this.toolRegistry.register(
      createDocTool({
        storage: new LocalStorage(resolve(root, "data/documents"), "/static/documents"),
        db: this.db,
        venvDir: resolve(root, "data/skills-env"),
        scriptPath: resolve(this.skillsDir, "scripts/gen_doc.py"),
        tmpDir: resolve(root, "data/tmp"),
      })
    );

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

    // Initialize usage meter
    this.usageMeter = new UsageMeter(this.db, (id) => this.modelRegistry.getConfig(id));

    // Initialize service-layer collaborators
    this.messageRepo = new MessageRepository(this.db);
    const traceModel =
      this.llmConfig.default === "openai"
        ? this.llmConfig.openai.model
        : this.llmConfig.anthropic.model;
    const traceProvider = this.llmConfig.default;
    this.traceRecorderFactory = () =>
      new TraceRecorder(this.traceManager, this.db, traceModel, traceProvider);

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
      toolNames: this.toolRegistry
        .getAll()
        .map((t) => t.name)
        .filter((name) => !DISABLED_HOST_TOOLS.has(name)),
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

  /**
   * Summarize a title for a conversation from its first user message, persist
   * it, and return it (or null if no title was generated — e.g. not the first
   * message, or the conversation was already retitled). The caller emits the
   * returned title to the client so the sidebar updates live.
   */
  async generateTitle(
    conversationId: string,
    userMessage: string
  ): Promise<string | null> {
    try {
      const conversation = await this.db.getConversation(conversationId);
      // Only (re)title conversations still on a default placeholder title.
      const isDefaultTitle =
        conversation?.title === "新对话" || conversation?.title === "New Chat";
      if (!conversation || !isDefaultTitle) return null;

      // Count user messages — only generate title on first user message
      const messages = await this.db.getMessages(conversationId);
      const userMsgCount = messages.filter((m) => m.role === "user").length;
      if (userMsgCount > 1) return null;

      const llm = this.getLLMProvider();
      let title = "";
      for await (const chunk of llm.chat([
        {
          role: "system",
          content:
            'Generate a short title (max 30 chars) for this conversation based on the user message, in the same language as the user. Reply with ONLY the title, no quotes, no punctuation at the end.',
        },
        { role: "user", content: userMessage },
      ])) {
        if (chunk.type === "text") title += chunk.content;
      }

      title = title.trim().replace(/^["']|["']$/g, "").slice(0, 50);
      if (title) {
        await this.db.updateConversationTitle(conversationId, title);
        return title;
      }
      return null;
    } catch (error) {
      console.warn("Failed to generate title:", error);
      return null;
    }
  }

  async *streamAgentResponse(
    conversationId: string,
    userMessage: string,
    agentId?: string,
    userId?: string,
    attachments?: AttachmentRef[]
  ): AsyncIterable<AgentEvent> {
    const def =
      this.agentRegistry.get(agentId ?? "general") ??
      this.agentRegistry.get("general")!;

    // ── Persist user message, load history (orphan tool messages filtered) ──
    const userMsgId = await this.messageRepo.saveUserMessage(
      conversationId,
      userMessage,
      attachments
    );
    const materialize = (atts: AttachmentRef[]) =>
      Promise.all(atts.map((a) => extractAttachment(a, this.uploadStorage)));
    const history = await this.messageRepo.loadHistory(
      conversationId,
      userMsgId,
      materialize
    );

    // ── Match skills, build agent ──
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

    // ── Start trace ──
    const recorder = this.traceRecorderFactory();
    recorder.start(conversationId, this.llmConfig.default);

    // Fresh per-request memory store — ephemeral/session state is request-scoped,
    // so concurrent users/sessions never clobber each other.
    const memory = new AgentMemoryStore({
      persistent: this.pgAdapter,
      userId: userId ?? "default",
    });

    const context: AgentContext = {
      llm,
      toolRegistry: this.toolRegistry,
      toolContext: { workingDirectory: process.cwd(), memory, userId: userId ?? "default" },
      memory,
    };

    let assistantContent = "";
    let currentToolCalls: { id: string; name: string; arguments: unknown }[] = [];
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let lastErrorMessage: string | undefined;

    // Build this turn's user input — text plus materialized attachment parts
    // (images as data-url ContentParts, documents as injected text).
    let runInput: string | ContentPart[] = userMessage;
    if (attachments?.length) {
      const parts = await materialize(attachments);
      runInput = [
        ...(userMessage ? [{ type: "text" as const, text: userMessage }] : []),
        ...parts,
      ];
    }

    try {
      for await (const event of agent.run(runInput, context, history)) {
        if (event.type === "text") {
          recorder.startLlmSpan();
          assistantContent += event.content;
        }

        if (event.type === "tool_call") {
          recorder.endLlmSpan();
          recorder.startToolSpan(event.name);
          currentToolCalls.push({
            id: event.id,
            name: event.name,
            arguments: event.input,
          });
        }

        if (event.type === "tool_result") {
          recorder.endToolSpan(event.isError ? "error" : "ok");

          const matchingCall = currentToolCalls.find(
            (tc) => tc.name === event.name
          );

          if (currentToolCalls.length > 0) {
            // Save assistant message with tool calls, then the tool result
            await this.messageRepo.saveAssistantWithToolCalls(
              conversationId,
              assistantContent || "",
              currentToolCalls
            );
            await this.messageRepo.saveToolResult(
              conversationId,
              matchingCall?.id,
              event.output
            );

            assistantContent = "";
            currentToolCalls = [];
          }
        }

        if (event.type === "done") {
          totalTokens = event.totalTokens;
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
        }

        if (event.type === "error") {
          lastErrorMessage = event.message;
        }

        yield event;
      }
    } finally {
      // Save final assistant message
      await this.messageRepo.saveFinalAssistant(
        conversationId,
        assistantContent || "",
        currentToolCalls
      );

      // Finish trace + spans (with the ACTUAL error message, if any)
      await recorder.finish({ totalTokens, errorMessage: lastErrorMessage });

      // Record usage (non-fatal)
      if (inputTokens + outputTokens > 0) {
        try {
          const cost = await this.usageMeter.record({
            userId: userId ?? "default",
            taskId: null,
            modelId: def.defaultModelId,
            usage: { inputCount: inputTokens, outputCount: outputTokens },
          });
          recorder.traceObject.metadata.totalCost = cost;
        } catch (err) {
          console.warn("[UsageMeter] Failed to record usage:", err);
        }
      }

    }
    // Title generation is driven by the route after the stream completes, so it
    // can emit the result as a `title` SSE event (live sidebar update).
  }

  async shutdown(): Promise<void> {
    await this.mcpManager.disconnectAll();
    if (this.bullmqQueue) {
      await this.bullmqQueue.close();
    }
    await this.db.close();
  }
}

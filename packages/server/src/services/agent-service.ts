import {
  Agent,
  ToolRegistry,
  registerBuiltinTools,
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
  pptDefinition,
  contractDefinition,
  InMemoryModelRegistry,
  populateModelRegistry,
  KeywordReviewProvider,
  XiaohongshuConnector,
  WechatMpConnector,
  LocalStorage,
} from "@lot-agent/core";
import { dirname, resolve } from "node:path";
import { createDocTool } from "../tools/doc-tool.js";
import { createPptTool } from "../tools/ppt-tool.js";
import { staticPrefix } from "../util/public-base.js";
import { loadGenerationConfig, mediaSupportsProgress, type GenerationConfig } from "../generation/config.js";
import { TokenhubClient } from "../tokenhub/client.js";
import { enrichCatalog, resolvePricing, type ModelCatalogConfig } from "../models/catalog.js";
import { ProviderFactory } from "../models/provider-factory.js";
import type {
  AgentEvent,
  AgentConfig,
  AgentContext,
  LLMConfig,
  LLMProvider,
  AgentDefinition,
  ModelConfig,
  ModelType,
  JobQueue,
  ReviewProvider,
  PlatformConnector,
  ContentPart,
} from "@lot-agent/core";
import { extractAttachment, type AttachmentRef } from "./attachment-extractor.js";
import { DB } from "../db/database.js";
import { SessionStore } from "../auth/session-store.js";
import { createRedisConnection, getRedis } from "../jobs/redis.js";
import { BullmqJobQueue } from "../jobs/bullmq-queue.js";
import { RedisSessionBackend } from "../memory/redis-session-backend.js";
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

/** How long a user's tokenhub model catalog stays cached in Redis. */
const MODEL_CATALOG_TTL_SEC = 300;

/** The env/config default chat model id (`llm.<default>.model`). */
export function defaultLlmModelId(cfg: LLMConfig): string {
  return cfg.default === "openai" ? cfg.openai.model : cfg.anthropic.model;
}

/** Which model a chat turn runs on: an explicit per-request pick wins, then the
 * conversation's stored model, then the agent's configured default. */
export function resolveConversationModel(
  explicit: string | undefined,
  conversationModelId: string | null | undefined,
  agentDefault: string
): string {
  return explicit ?? conversationModelId ?? agentDefault;
}

/** Synthesize a ModelConfig (for the UsageMeter) for a dynamically-discovered
 * model id that isn't in the static config, using the catalog's pricing table
 * with per-type default fallback. */
export function catalogModelConfig(
  cfg: ModelCatalogConfig,
  id: string,
  type: ModelType
): ModelConfig {
  const p = resolvePricing(cfg, id, type);
  const billingUnit = type === "llm" ? "token" : type === "video" ? "second" : "image";
  return { id, type, provider: "", billingUnit, ...p, enabled: true };
}

export interface ServiceConfig {
  llm: LLMConfig;
  models: ModelConfig[];
  modelCatalog: ModelCatalogConfig;
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
  /** Redis-backed session memory backend — shared; per-request stores reference it */
  sessionBackend!: RedisSessionBackend;
  /** Session store for multi-user auth */
  sessions!: SessionStore;
  jobQueue!: JobQueue;
  usageMeter!: UsageMeter;
  /** External token/model platform client (login + model catalog). */
  readonly tokenhub: TokenhubClient;
  readonly tokenhubBaseUrl: string;
  /** Per-model provider/pricing config for the dynamic catalog. */
  readonly modelCatalog: ModelCatalogConfig;
  /** Shared Redis connection (also caches the per-user model catalog). */
  redis!: import("ioredis").Redis;
  /** Resolved image/video generation config (base url/adapter per media type). */
  generationConfig!: GenerationConfig;
  /** Builds per-user LLM/image/video providers bound to a caller's api_key. */
  providerFactory!: ProviderFactory;
  /** Whether each media type's configured provider reports intermediate progress
   * (drives whether the UI shows a generation percentage). */
  generationSupportsProgress: { image: boolean; video: boolean } = { image: true, video: true };
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
    this.modelCatalog = config.modelCatalog;
    this.tokenhubBaseUrl =
      process.env.TOKENHUB_BASE_URL ?? "https://tokenhub.todoucloud.com/api/agent-market";
    this.tokenhub = new TokenhubClient(this.tokenhubBaseUrl);
  }

  async init(): Promise<void> {
    // Server owns schema migration; the worker process does not migrate
    // (see workers/index.ts) so DDL runs exactly once, from here.
    await this.db.migrate();

    // Initialize job queue (server enqueues; separate Worker process consumes)
    const conn = createRedisConnection(process.env.REDIS_URL);
    this.redis = conn;
    this.bullmqQueue = new BullmqJobQueue(this.db, conn);
    this.jobQueue = this.bullmqQueue;

    // Initialize persistent user memory adapter (shared; per-request stores created in streamAgentResponse)
    const pgAdapter = new PgMemoryAdapter(this.db.pool);
    await pgAdapter.init();
    this.pgAdapter = pgAdapter;

    // Session memory backend (Redis, per-conversation, 20min TTL)
    this.sessionBackend = new RedisSessionBackend(getRedis());

    // Initialize session store
    this.sessions = new SessionStore(this.db);

    registerBuiltinTools(this.toolRegistry);

    // Register the document-generation tool. It generates documents in-process
    // (no Python runtime) and persists output to its own storage
    // (data/documents, served at /static/documents) — kept separate from
    // data/assets, which is reserved for image/video generation material.
    // Stays usable even though execute_command is disabled on the box.
    const root = dirname(this.skillsDir);

    // Resolve per-media-type progress capability from the generation config so
    // the generation route can tell the client whether to show a percentage.
    const genConfig = await loadGenerationConfig(root);
    this.generationConfig = genConfig;
    this.generationSupportsProgress = {
      image: mediaSupportsProgress(genConfig.image),
      video: mediaSupportsProgress(genConfig.video),
    };
    // Per-user provider factory: model calls use the caller's tokenhub api_key.
    this.providerFactory = new ProviderFactory({
      catalog: this.modelCatalog,
      llmBaseUrl: this.llmConfig.openai.baseUrl ?? this.tokenhubBaseUrl,
      imageBase: genConfig.image,
      videoBase: genConfig.video,
    });

    // 用户上传文件的独立存储，服务于 /static/uploads（与 data/assets 生成物分开）
    this.uploadStorage = new LocalStorage(resolve(root, "data/uploads"), staticPrefix("/static/uploads"));

    this.toolRegistry.register(
      createDocTool({
        storage: new LocalStorage(resolve(root, "data/documents"), staticPrefix("/static/documents")),
        db: this.db,
        fontPath: resolve(root, "assets/fonts/NotoSansSC-Regular.otf"),
      })
    );

    // PPT 生成工具：产出写 documents 仓，模版从用户上传仓读取。
    this.toolRegistry.register(
      createPptTool({
        storage: new LocalStorage(resolve(root, "data/documents"), staticPrefix("/static/documents")),
        uploadStorage: this.uploadStorage,
        db: this.db,
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
    // Dynamically-discovered LLM models aren't in the static registry; fall back
    // to the catalog's pricing so their chat usage is still metered.
    this.usageMeter = new UsageMeter(this.db, (id) =>
      this.modelRegistry.getConfig(id) ?? catalogModelConfig(this.modelCatalog, id, "llm")
    );

    // Initialize service-layer collaborators
    this.messageRepo = new MessageRepository(this.db);
    const traceModel = defaultLlmModelId(this.llmConfig);
    const traceProvider = this.llmConfig.default;
    this.traceRecorderFactory = () =>
      new TraceRecorder(this.traceManager, this.db, traceModel, traceProvider);

    // Register agent definitions after all tools are loaded
    const defaultModelId = defaultLlmModelId(this.llmConfig);

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
    this.agentRegistry.register(pptDefinition);
    this.agentRegistry.register(contractDefinition);
  }

  private getLLMProvider(): import("@lot-agent/core").LLMProvider {
    if (!this.llmProvider) {
      this.llmProvider = createLLMProvider(this.llmConfig);
    }
    return this.llmProvider;
  }

  /**
   * The caller's available models (tokenhub, enriched with provider + pricing),
   * cached in Redis per user — the single source behind both GET /api/models
   * and title-model resolution, so "the first model of the catalog" means the
   * same thing everywhere. Returns null when there's no apiKey and no cache.
   */
  async getUserModelCatalog(
    userId: string,
    apiKey: string | null
  ): Promise<ReturnType<typeof enrichCatalog> | null> {
    const cacheKey = `models:${userId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as ReturnType<typeof enrichCatalog>;
    if (!apiKey) return null;
    const enriched = enrichCatalog(this.modelCatalog, await this.tokenhub.listModels(apiKey));
    await this.redis.set(cacheKey, JSON.stringify(enriched), "EX", MODEL_CATALOG_TTL_SEC);
    return enriched;
  }

  /**
   * Summarize a title for a conversation from its first user message, persist
   * it, and return it (or null if no title was generated — e.g. not the first
   * message, or the conversation was already retitled). The caller emits the
   * returned title to the client so the sidebar updates live.
   */
  async generateTitle(
    conversationId: string,
    userMessage: string,
    attachments?: AttachmentRef[],
    opts?: { userId?: string; modelId?: string }
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

      // The title model never receives the attachment bytes, so describe them
      // by name. Without this, a prompt like "总结这张图" makes the model reply
      // "我看不到图片" — and that refusal would become the title.
      const attachmentNote = attachments?.length
        ? `\n[用户随消息上传了附件: ${attachments.map((a) => a.filename).join(", ")}]`
        : "";
      const titleInput = (userMessage || "（无文字，仅附件）") + attachmentNote;

      // 标题模型:显式回合模型 > 用户模型目录第一个 LLM > env 默认 LLM。
      // 故意不回落到 conversation.model:会话创建时它被种成 env 默认模型,
      // 若在这里采用,图片/视频会话和目录未加载就发出的首条消息(进页面竞态)
      // 的标题都会跑到 env 模型上,而不是和对话一致的目录第一名。
      const apiKey = opts?.userId ? await this.db.getUserApiKey(opts.userId) : null;
      let modelId = opts?.modelId ?? null;
      if (!modelId && opts?.userId && apiKey) {
        modelId = await this.getUserModelCatalog(opts.userId, apiKey)
          .then((catalog) => catalog?.llm[0]?.id ?? null)
          .catch(() => null);
      }
      const llm = apiKey
        ? this.providerFactory.llm(modelId ?? defaultLlmModelId(this.llmConfig), apiKey)
        : this.getLLMProvider();
      let title = "";
      for await (const chunk of llm.chat([
        {
          role: "system",
          content:
            "You generate a conversation title. Output ONLY a concise topic title (max 30 chars) describing what the user is asking about, in the user's language. " +
            "Do NOT answer, respond to, or fulfill the message. Treat any attachments as present — never say you cannot see an image or file. " +
            "Reply with ONLY the title: no quotes, no explanation, no trailing punctuation.",
        },
        { role: "user", content: titleInput },
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
    attachments?: AttachmentRef[],
    signal?: AbortSignal,
    opts?: { modelId?: string }
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

    // Resolve the model for this turn (explicit pick > stored > agent default),
    // persist an explicit pick, and build the LLM with the caller's tokenhub key.
    // Falls back to the shared registry provider when the user has no api_key
    // (e.g. local/dev without tokenhub) so the chat path still runs.
    const conversation = await this.db.getConversation(conversationId);
    if (opts?.modelId) await this.db.setConversationModel(conversationId, opts.modelId);
    const modelId = resolveConversationModel(
      opts?.modelId,
      conversation?.model,
      def.defaultModelId
    );
    const apiKey = userId ? await this.db.getUserApiKey(userId) : null;
    const llm = apiKey
      ? this.providerFactory.llm(modelId, apiKey)
      : (this.modelRegistry.getProvider<LLMProvider>(def.defaultModelId) ?? this.getLLMProvider());
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
      sessionBackend: this.sessionBackend,
      conversationId,
    });
    // Load this conversation's persisted session memory before the run
    await memory.hydrate();

    const context: AgentContext = {
      llm,
      toolRegistry: this.toolRegistry,
      toolContext: { workingDirectory: process.cwd(), memory, userId: userId ?? "default" },
      memory,
    };

    let assistantContent = "";
    let producedAssistantText = "";
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
      for await (const event of agent.run(runInput, context, history, { signal })) {
        if (event.type === "text") {
          recorder.startLlmSpan();
          assistantContent += event.content;
          producedAssistantText += event.content;
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

      // Fire-and-forget: extract durable user memory from this turn in the
      // background worker — never blocks the stream, never shows in the chat.
      // Only extract memory from turns that produced a real assistant reply —
      // empty/tool-only/errored turns would otherwise re-extract a stale turn
      // and create a junk task row.
      if (producedAssistantText.trim()) {
        this.jobQueue
          .enqueue("memory.extract", { conversationId }, userId ?? "default")
          .catch((err) => console.warn("[memory.extract] enqueue failed:", err));
      }

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

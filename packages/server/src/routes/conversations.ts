import { parseChatSourceTypes } from "@lot-agent/core";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { estimateCost, MAX_IMAGE_EDIT_REFERENCES, type ObjectStorage } from "@lot-agent/core";
import { activeMarketingVideoProfile } from "../marketing-video/model.js";
import type { AgentService } from "../services/agent-service.js";
import { makePricingLookup } from "../billing/pricing-lookup.js";
import { agentEventToSse } from "../services/sse-adapter.js";
import { attachmentKind, type AttachmentRef } from "../services/attachment-extractor.js";
import type { KnowledgeBaseRef } from "../services/rag-client.js";
import type { StoredMessage } from "../db/database.js";
import { billedVideoSeconds, finalizeImageSettings, grokVideoIssue, pickGenerationSettings, pickVideoReferenceInputs, resolveVideoGenerateAudio } from "../generation/input.js";
import { agentExtension, AgentConversationError } from "../services/agent-extensions.js";
import { ImageSceneError, imageSceneNeedsReference, imageSceneUsesSet, parseImageScene, planImageScene } from "../generation/image-scene.js";
import {
  composeImages, composeLayoutFits, outputStorageKey, parseComposeLayout, storedComposites, type GenerationComposite,
} from "../generation/compose.js";
import { IMAGE_REDO_TASK } from "../generation/run-job.js";
import { posterRenderKey, renderPoster } from "../generation/poster-render.js";
import {
  editPosterLayout, parsePosterLayout, planPoster, posterBackgroundPrompt, PosterPlanError, posterTemplateFor, type PosterLayout,
} from "@lot-agent/core/poster";
import { buildExportZip, parseExportPreset, safeExportName, type ExportSource } from "../generation/image-export.js";
import {
  DEFAULT_MINIPROGRAM_CONFIG,
  downshiftMiniprogramImageSize,
  isMiniprogramClient,
  isMiniprogramImageSlot,
  resolveMiniprogramImageModel,
  type MiniprogramConfig,
} from "../miniprogram/models.js";

type Variables = { userId: string };

function validVideoPublication(value: unknown): value is { copy: string; tags: string } {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return typeof data.copy === "string" && data.copy.length <= 10000
    && typeof data.tags === "string" && data.tags.length <= 2000;
}


/** Server-side cap (the InputBox MAX_FILES=5 is only a client hint). */
const MAX_ATTACHMENTS = 5;
const MAX_KNOWLEDGE_BASES = 5;

/**
 * Run-lease staleness window (report #20 concurrency half / architecture
 * #10). Matches the Agent's `maxRunTimeMs` default (`core/agent/agent.ts`) —
 * a lease only needs reclaiming when its holder process crashed/hung and
 * never reached its `finally` release, so this should never fire in the
 * ordinary "still running" case; it's purely a dead-holder fallback.
 */
const RUN_LEASE_STALE_MS = 1_800_000;

const RUN_CONFLICT_MESSAGE = "对话正在处理另一条消息，请稍候再试";

/** Attachment slots accepted from the client; anything else is dropped. */
const VALID_SLOTS = new Set(["ppt_template", "ppt_background", "content", "contract_old", "contract_new"]);

function validateKnowledgeBaseIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_KNOWLEDGE_BASES &&
    value.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value).size === value.length
  );
}

function miniprogramCfg(service: AgentService): MiniprogramConfig {
  return service.miniprogram ?? DEFAULT_MINIPROGRAM_CONFIG;
}

async function resolveImageModelId(
  service: AgentService,
  userId: string,
  selectedModel: string | undefined
): Promise<string | undefined> {
  const cfg = miniprogramCfg(service);
  if (!isMiniprogramImageSlot(selectedModel, cfg)) return selectedModel;
  let catalogIds: string[] | undefined;
  try {
    const apiKey = await service.db.getUserApiKey?.(userId, service.managedKeysEnabled);
    const catalog = await service.getUserModelCatalog?.(userId, apiKey ?? null);
    catalogIds = catalog?.image?.map((model) => model.id);
  } catch {
    catalogIds = undefined;
  }
  return resolveMiniprogramImageModel(selectedModel, catalogIds, cfg);
}

function storedKnowledgeBases(metadata: Record<string, unknown> | undefined): KnowledgeBaseRef[] {
  const value = metadata?.knowledgeBases;
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is KnowledgeBaseRef =>
        !!item &&
        typeof item === "object" &&
        typeof (item as KnowledgeBaseRef).id === "string" &&
        typeof (item as KnowledgeBaseRef).name === "string"
    )
    .slice(0, MAX_KNOWLEDGE_BASES);
}

export function createConversationRoutes(service: AgentService) {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/projects", async (c) => c.json(await service.db.listConversationProjects(c.get("userId"))));
  app.post("/projects", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.name !== "string" || !body.name.trim() || body.name.trim().length > 80) {
      return c.json({ error: "项目名称需为 1–80 个字符" }, 400);
    }
    return c.json(await service.db.createConversationProject(randomUUID(), c.get("userId"), body.name.trim()), 201);
  });
  app.get("/projects/:projectId/conversations", async (c) => {
    const projectId = c.req.param("projectId");
    if (!await service.db.ownsConversationProject(projectId, c.get("userId"))) return c.json({ error: "Not found" }, 404);
    return c.json(await service.db.listConversations(c.get("userId"), { projectId }));
  });
  app.put("/:id/project", async (c) => {
    const userId = c.get("userId");
    const conversation = await service.db.getConversation(c.req.param("id"));
    if (!conversation || conversation.user_id !== userId) return c.json({ error: "Not found" }, 404);
    if (conversation.channel === "feishu") return c.json({ error: "飞书会话固定展示在通用 Agent 顶部" },409);
    const body = await c.req.json().catch(() => null);
    if (!body || (body.projectId !== null && typeof body.projectId !== "string")) return c.json({ error: "Invalid projectId" }, 400);
    if (body.projectId !== null && !await service.db.ownsConversationProject(body.projectId, userId)) return c.json({ error: "Not found" }, 404);
    return c.json(await service.db.setConversationProject(conversation.id, userId, body.projectId));
  });

  // List conversations — scoped to current user, keyset-paginated (latest
  // first) over updated_at. ?limit=20&cursor=<id> ; the cursor is the id of the
  // last row from the previous page. Omitting limit returns the full list
  // (back-compat).
  app.get("/", async (c) => {
    const userId = c.get("userId");
    const agentIdRaw = c.req.query("agentId");
    const agentId = agentIdRaw && /^[a-zA-Z0-9_-]{1,64}$/.test(agentIdRaw) ? agentIdRaw : undefined;
    const includePreview =
      c.req.query("includePreview") === "1" || c.req.query("includePreview") === "true";
    const listOpts = { agentId, includePreview };
    const limitRaw = c.req.query("limit");
    if (limitRaw == null) {
      const conversations = await service.db.listConversations(userId, listOpts);
      return c.json(conversations);
    }
    const limit = Number(limitRaw);
    if (!Number.isFinite(limit)) {
      return c.json({ error: "limit must be a number" }, 400);
    }
    const clamped = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const cursorId = c.req.query("cursor") || undefined;
    const items = await service.db.listConversations(userId, {
      ...listOpts,
      limit: clamped,
      cursorId,
    });
    // nextCursor: id of the last row when a full page came back (more may
    // exist); null once a short page signals the end.
    const nextCursor =
      items.length === clamped ? (items[items.length - 1] as { id: string }).id : null;
    return c.json({ items, nextCursor });
  });

  // Create conversation — owned by current user
  app.post("/", async (c) => {
    const userId = c.get("userId");
    type CreateBody = { title?: string; agentId?: string; featureScope?: string; projectId?: string; videoPublication?: unknown };
    const body = await c.req.json<CreateBody>().catch((): CreateBody => ({}));
    if (body.projectId !== undefined && (typeof body.projectId !== "string" || !await service.db.ownsConversationProject(body.projectId, userId))) {
      return c.json({ error: "Not found" }, 404);
    }
    const id = randomUUID();
    const title = body.title ?? "新对话";
    const agentId = body.agentId ?? "general";
    const extension = agentExtension(agentId);
    const isMiniprogram = isMiniprogramClient(c.req.header("x-lot-client"));
    const model = extension?.ownerKeyOnly
      ? undefined
      : isMiniprogram
        ? miniprogramCfg(service).llm
        : service["llmConfig"].default === "openai"
          ? service["llmConfig"].openai.model
          : service["llmConfig"].anthropic.model;
    const provider = extension?.ownerKeyOnly ? undefined : service["llmConfig"].default;
    let metadata: Record<string, unknown> | undefined;
    if (body.videoPublication !== undefined) {
      if (!["video", "marketing_video"].includes(agentId) || !validVideoPublication(body.videoPublication)) {
        return c.json({ error: "Invalid video publication" }, 400);
      }
      metadata = { videoPublication: { copy: body.videoPublication.copy, tags: body.videoPublication.tags } };
    }
    try {
      metadata = extension?.conversationMetadata?.({ featureScope: body.featureScope }) ?? metadata;
    } catch (error) {
      if (error instanceof AgentConversationError) return c.json({ error: error.message }, 400);
      throw error;
    }
    const conversation = await service.db.createConversation(
      id, title, model, provider, agentId, userId, metadata, body.projectId
    );
    return c.json(conversation, 201);
  });

  app.put("/:id/video-publication", async (c) => {
    const id = c.req.param("id");
    const conv = await service.db.getConversation(id);
    if (!conv || conv.user_id !== c.get("userId")) return c.json({ error: "Not found" }, 404);
    const body: unknown = await c.req.json().catch(() => null);
    if (!["video", "marketing_video"].includes(conv.agent_id) || !validVideoPublication(body)) return c.json({ error: "Invalid video publication" }, 400);
    await service.db.mergeConversationMetadata(id, { videoPublication: { copy: body.copy, tags: body.tags } });
    return c.json({ ok: true });
  });

  app.get("/:id/runs", async (c) => {
    const conversation = await service.db.getConversation(c.req.param("id"));
    if (!conversation || conversation.user_id !== c.get("userId")) return c.json({ error: "Not found" }, 404);
    return c.json({ runs: await service.runRepository.list(conversation.id, c.get("userId")) });
  });

  app.post("/:id/operations/:operationId/verify", async (c) => {
    const conversation = await service.db.getConversation(c.req.param("id"));
    if (!conversation || conversation.user_id !== c.get("userId")) return c.json({ error: "Not found" }, 404);
    const operationId = c.req.param("operationId");
    const body = await c.req.json().catch(() => null);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(operationId) ||
      !body || !["succeeded", "failed"].includes(body.outcome)) return c.json({ error: "Invalid verification" }, 400);
    const verified = await service.runRepository.resolve(conversation.id, c.get("userId"), operationId, body.outcome);
    return verified ? c.json({ ok: true }) : c.json({ error: "Operation is not awaiting verification or the conversation is still running" }, 409);
  });

  // Get conversation with messages — ownership check
  app.get("/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const conversation = await service.db.getConversation(id);
    if (!conversation) return c.json({ error: "Not found" }, 404);
    if (conversation.user_id !== userId) return c.json({ error: "Not found" }, 404);

    const messages = await service.db.getMessages(id);
    const ratings = await service.db.getRatingsForConversation(id);
    const toolCallsMap = await service.db.getToolCallsForConversation(id);

    // Build a map of tool_call_id -> tool_name for tool result messages
    const toolNameMap = new Map<string, string>();
    for (const tcs of toolCallsMap.values()) {
      for (const tc of tcs) {
        toolNameMap.set(tc.tool_call_id, tc.tool_name);
      }
    }

    const enriched = messages.map((m) => {
      const toolCalls = toolCallsMap.get(m.id);
      const toolName = m.tool_call_id
        ? toolNameMap.get(m.tool_call_id)
        : undefined;
      return {
        ...m,
        rating: ratings.get(m.id) ?? null,
        tool_calls: toolCalls
          ? JSON.stringify(
              toolCalls.map((tc) => ({
                id: tc.tool_call_id,
                name: tc.tool_name,
                input: tc.tool_input,
              }))
            )
          // Not a StoredMessage column; kept for rows that carry it.
          : (m as StoredMessage & { tool_calls?: unknown }).tool_calls,
        // Add tool_name for tool result messages
        tool_name: toolName ?? null,
      };
    });
    return c.json({ ...conversation, messages: enriched });
  });

  // Persist the knowledge bases attached to this conversation. This endpoint
  // is called as soon as the user confirms or removes a selection, so the
  // choice survives reloads even when no subsequent message is sent.
  app.put("/:id/knowledge-bases", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const conversation = await service.db.getConversation(id);
    if (!conversation || conversation.user_id !== userId) {
      return c.json({ error: "Not found" }, 404);
    }
    const body: { knowledgeBaseIds?: unknown; knowledgeSourceTypes?: unknown } = await c.req.json().catch(() => ({}));
    if (!validateKnowledgeBaseIds(body.knowledgeBaseIds)) {
      return c.json({ error: `invalid knowledgeBaseIds (max ${MAX_KNOWLEDGE_BASES})` }, 400);
    }
    if (body.knowledgeBaseIds.length && conversation.agent_id !== "general") {
      return c.json({ error: "knowledge bases are only available in the general assistant" }, 400);
    }
    let sourceTypes;
    try { sourceTypes = parseChatSourceTypes(body.knowledgeSourceTypes); }
    catch { return c.json({ error: "invalid knowledgeSourceTypes" }, 400); }
    try {
      const knowledgeBases = (await service.resolveKnowledgeBases(userId, body.knowledgeBaseIds)).map((base) => ({ ...base, sourceTypes }));
      await service.db.mergeConversationMetadata(id, { knowledgeBases });
      return c.json({ knowledgeBases });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "知识库不可用" },
        502
      );
    }
  });

  // Delete conversation (soft delete) — ownership check
  app.delete("/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const conversation = await service.db.getConversation(id);
    if (!conversation || conversation.user_id !== userId) {
      return c.json({ error: "Not found" }, 404);
    }
    if (conversation.channel === "feishu") return c.json({ error: "请在飞书中发送或取消任务，此处保留完整记录" },409);
    const deleted = await service.db.deleteConversation(id);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  // Regenerate: delete messages after a given message — ownership check
  app.post("/:id/regenerate", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const conversation = await service.db.getConversation(id);
    if (!conversation || conversation.user_id !== userId) {
      return c.json({ error: "Not found" }, 404);
    }
    if (conversation.channel === "feishu") return c.json({ error: "请在飞书中发送或取消任务，此处保留完整记录" },409);
    try {
      agentExtension(conversation.agent_id)?.assertConversation?.(conversation.metadata);
    } catch (error) {
      if (error instanceof AgentConversationError) return c.json({ error: error.message }, 400);
      throw error;
    }

    const body = await c.req.json<{ afterMessageId: string }>();
    if (!body.afterMessageId) {
      return c.json({ error: "afterMessageId is required" }, 400);
    }

    // Deleting history out from under a turn that's currently being written
    // (another tab/device mid-stream) would race that turn's own inserts —
    // claim the same run lease messages/:id uses so the two can't overlap.
    const runId = randomUUID();
    const claimed = await service.db.claimConversationRun(id, runId, RUN_LEASE_STALE_MS);
    if (!claimed) {
      return c.json({ error: RUN_CONFLICT_MESSAGE }, 409);
    }
    try {
      const deleted = await service.db.deleteMessagesFromAndAfter(id, body.afterMessageId);
      if (!deleted) return c.json({ error: "Not found" }, 404);
      return c.json({ ok: true });
    } finally {
      await service.db.releaseConversationRun(id, runId);
    }
  });

  // Send message — returns SSE stream, ownership check
  app.post("/:id/messages", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const conversation = await service.db.getConversation(id);
    if (!conversation || conversation.user_id !== userId) {
      return c.json({ error: "Not found" }, 404);
    }
    if (conversation.channel === "feishu") return c.json({ error: "请在飞书中发送或取消任务，此处保留完整记录" },409);
    try {
      agentExtension(conversation.agent_id)?.assertConversation?.(conversation.metadata);
    } catch (error) {
      if (error instanceof AgentConversationError) return c.json({ error: error.message }, 400);
      throw error;
    }

    const body = await c.req.json<{
      content: string;
      attachments?: AttachmentRef[];
      modelId?: string;
      knowledgeBaseIds?: string[];
      knowledgeSourceTypes?: unknown;
    }>();
    if (!body.content && !(body.attachments && body.attachments.length)) {
      return c.json({ error: "content or attachments required" }, 400);
    }

    // An omitted field means "keep using this conversation's selection".
    // An explicit [] is the user's manual removal and clears the persisted set.
    const suppliedKnowledgeBaseIds = body.knowledgeBaseIds;
    const knowledgeBaseIds =
      suppliedKnowledgeBaseIds ?? storedKnowledgeBases(conversation.metadata).map((item) => item.id);
    if (!validateKnowledgeBaseIds(knowledgeBaseIds)) {
      return c.json({ error: `invalid knowledgeBaseIds (max ${MAX_KNOWLEDGE_BASES})` }, 400);
    }
    if (knowledgeBaseIds.length && conversation.agent_id !== "general") {
      return c.json({ error: "knowledge bases are only available in the general assistant" }, 400);
    }
    let knowledgeBases: Awaited<ReturnType<typeof service.resolveKnowledgeBases>> = [];
    if (knowledgeBaseIds.length) {
      try {
        knowledgeBases = await service.resolveKnowledgeBases(userId, knowledgeBaseIds, (suppliedKnowledgeBaseIds === undefined || JSON.stringify(knowledgeBaseIds) === JSON.stringify(storedKnowledgeBases(conversation.metadata).map((item) => item.id))) ? (storedKnowledgeBases(conversation.metadata).every((item) => item.source === "local") ? "local" : "remote") : undefined);
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : "知识库不可用" },
          502
        );
      }
    }
    try {
      const sameSelection = suppliedKnowledgeBaseIds === undefined || JSON.stringify(knowledgeBaseIds) === JSON.stringify(storedKnowledgeBases(conversation.metadata).map((item) => item.id));
      const sourceTypes = parseChatSourceTypes(body.knowledgeSourceTypes ?? (sameSelection ? storedKnowledgeBases(conversation.metadata)[0]?.sourceTypes : undefined));
      knowledgeBases = knowledgeBases.map((base) => ({ ...base, sourceTypes }));
    } catch { return c.json({ error: "invalid knowledgeSourceTypes" }, 400); }
    if (suppliedKnowledgeBaseIds !== undefined || body.knowledgeSourceTypes !== undefined) {
      await service.db.mergeConversationMetadata(id, { knowledgeBases });
    }

    // Validate + canonicalize attachments against the caller's OWN assets.
    // The client-supplied url/mime/size are untrusted: a forged url enables
    // path traversal (#1) and referencing another user's assetId leaks their
    // file (IDOR, #2). Re-derive every field from the asset row keyed by the
    // owned assetId so the rest of the pipeline only sees trusted values.
    const rawAttachments = body.attachments ?? [];
    if (rawAttachments.length > MAX_ATTACHMENTS) {
      return c.json({ error: `too many attachments (max ${MAX_ATTACHMENTS})` }, 400);
    }
    const attachments: AttachmentRef[] = [];
    for (const a of rawAttachments) {
      const asset = a.assetId ? await service.db.getAsset(a.assetId) : null;
      if (!asset || asset.user_id !== userId) {
        return c.json({ error: "attachment not found" }, 404);
      }
      attachments.push({
        assetId: asset.id,
        filename: a.filename, // display-only, not used for file access
        mime: asset.mime,
        size: asset.size_bytes,
        url: asset.url,
        kind: attachmentKind(asset.mime),
        slot: a.slot && VALID_SLOTS.has(a.slot) ? a.slot : undefined,
      });
    }

    // Claim the run lease as the last step before starting the stream — every
    // earlier `return` above is a plain validation failure that never touched
    // the conversation, so it doesn't need to release anything. From here on,
    // ANY exit path (normal finish, thrown error, or the client disconnecting
    // mid-stream — `c.req.raw.signal` aborts and `service.streamAgentResponse`'s
    // own `for await` unwinds, see agent-service.ts) unwinds through the
    // `finally` below, which is the one place that releases the lease.
    const desktopCapability = c.req.header("X-Lot-Desktop-Capability");
    const desktopTools = desktopCapability && conversation.agent_id === "general"
      ? service.desktopTools?.claim(desktopCapability, userId, id) : undefined;
    if (desktopCapability && !desktopTools) return c.json({ error: "Desktop capability unavailable" }, 403);
    const runId = randomUUID();
    const claimed = await service.db.claimConversationRun(id, runId, RUN_LEASE_STALE_MS);
    if (!claimed) {
      if (desktopCapability) service.desktopTools.close(desktopCapability);
      return c.json({ error: RUN_CONFLICT_MESSAGE }, 409);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: Record<string, unknown>) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        };

        // `stream_end` is the client's permission to start the next turn. Keep
        // that signal fenced behind the database lease release; otherwise the
        // client can immediately submit an ask_user/propose_outline answer while
        // this request still owns the conversation, and the new request gets a
        // spurious 409. Title generation is only best-effort tail work and does
        // not need to hold the message-writing lease.
        let leaseReleased = false;
        const execution = new AbortController();
        const signal = AbortSignal.any([c.req.raw.signal, execution.signal]);
        let renewing = false;
        const heartbeat = setInterval(async () => {
          if (renewing || leaseReleased || !service.db.renewConversationRun) return;
          renewing = true;
          try {
            if (!await service.db.renewConversationRun(id, runId)) execution.abort(new Error("Execution lease lost"));
          } catch { execution.abort(new Error("Execution lease renewal failed")); }
          finally { renewing = false; }
        }, 20_000);
        heartbeat.unref();
        const releaseLease = async () => {
          if (leaseReleased) return;
          clearInterval(heartbeat);
          await service.db.releaseConversationRun(id, runId);
          leaseReleased = true;
        };

        // Open the stream immediately with an SSE comment so the client (and
        // any reverse proxy) flushes the connection before the first token,
        // rather than holding everything until the response completes.
        try {
          controller.enqueue(encoder.encode(": open\n\n"));
          for await (const event of service.streamAgentResponse(
            id,
            body.content ?? "",
            conversation.agent_id,
            userId,
            attachments,
            signal,
            { modelId: body.modelId, knowledgeBases, runId, ...(desktopTools ? { desktopTools } : {}) }
          )) {
            send(agentEventToSse(event));
          }
          // Release the server-side turn first, then tell the client it may
          // unlock. The title is a whole extra LLM round-trip and deliberately
          // runs after both sides agree that the conversation turn has ended.
          if (desktopCapability) service.desktopTools.close(desktopCapability);
          await releaseLease();
          send({ type: "stream_end" });
          // Summarize + persist the conversation title (first message only) and
          // push it to the client so the sidebar updates live, no refresh. The
          // client reads the SSE connection until it closes, so a title event
          // after stream_end is still applied.
          try {
            const title = await service.generateTitle(
              id,
              body.content ?? "",
              attachments,
              {
                userId,
                agentId: conversation.agent_id,
              }
            );
            if (title) send({ type: "title", title });
          } catch {
            // title generation is best-effort
          }
        } catch (error) {
          await releaseLease();
          send({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          send({ type: "stream_end" });
        } finally {
          // Covers exits before the normal pre-stream_end release: an agent
          // error, a failed release attempt, or a client disconnect (the
          // AbortSignal unwinds `service.streamAgentResponse`'s for-await).
          // `releaseLease` is idempotent, so the normal path is a no-op here.
          try {
            await releaseLease();
          } catch (err) {
            console.warn("[run-lease] release failed:", err);
          }
          if (desktopCapability) service.desktopTools.close(desktopCapability);
          clearInterval(heartbeat);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // Disable proxy buffering (nginx & friends) so SSE tokens are
        // forwarded as they arrive instead of being held until the end.
        "X-Accel-Buffering": "no",
      },
    });
  });

  return app;
}

type GenVariables = { userId: string };

export function createGenerationRoutes(service: AgentService, deps: { assets?: ObjectStorage } = {}) {
  const app = new Hono<{ Variables: GenVariables }>();

  app.post("/:id/generations", async (c) => {
    const userId = c.get("userId");
    const conversationId = c.req.param("id");

    const conv = await service.db.getConversation(conversationId);
    if (!conv || (conv as { user_id?: string }).user_id !== userId) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    if (conv.channel === "feishu") return c.json({ error: "请在飞书中发送任务" },409);

    let body: {
      prompt?: string;
      mediaType?: "image" | "video";
      settings?: Record<string, unknown>;
      media?: { type: string; url: string }[];
      input_reference?: unknown;
      reference_video?: unknown;
      reference_audio?: unknown;
      first_frame?: unknown;
      last_frame?: unknown;
      model?: string;
      /** Image scene: 自由创作 by default; the e-commerce scenes are checked and rewritten first. */
      scene?: unknown;
      /** 真实字体: the model paints a text-free picture and the wording is typeset on it. 自由创作 only. */
      realText?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const prompt = (body.prompt ?? "").trim();
    const mediaType = body.mediaType;
    if (!prompt || (mediaType !== "image" && mediaType !== "video")) {
      return c.json({ error: "prompt and mediaType (image|video) are required" }, 400);
    }
    const scene = mediaType === "image" ? parseImageScene(body.scene) : "free";
    if (!scene) return c.json({ error: "unknown image scene" }, 400);
    const realText = mediaType === "image" && scene === "free" && body.realText === true;
    // The mini program and marketing studio create one conversation per paid video attempt. Use a
    // database lease (shared across server processes) plus its durable message
    // to replay retries, including a retry after enqueue returned no response.
    const videoRunId = mediaType === "video" && (conv.agent_id === "marketing_video" || isMiniprogramClient(c.req.header("x-lot-client")))
      ? randomUUID() : null;
    if (videoRunId && !await service.db.claimConversationRun(conversationId, videoRunId, RUN_LEASE_STALE_MS)) {
      return c.json({ error: "视频提交结果待确认，请查询原任务，勿重复生成" }, 409);
    }
    try {
      if (videoRunId) {
        const messages = await service.db.getMessages(conversationId);
        const existing = messages.find((m) => m.role === "assistant" && m.metadata?.kind === "generation" && m.metadata?.mediaType === "video");
        if (existing) {
          const taskId = existing.metadata.taskId;
          if (typeof taskId !== "string" || !taskId) {
            return c.json({ error: "视频提交结果待确认，请查询原任务，勿重复生成" }, 409);
          }
          return c.json({ userMessage: messages.find((m) => m.role === "user"), assistantMessage: existing, taskId }, 202);
        }
      }
      // Client settings pass a per-media whitelist so identity fields
      // (conversationId/assistantMessageId/userId) can never ride along.
      const selectedModel = conv.agent_id === "marketing_video" && mediaType === "video"
        ? activeMarketingVideoProfile().modelId
        : typeof body.model === "string" && body.model ? body.model : undefined;
      if (conv.agent_id === "marketing_video" && mediaType === "video") {
        const duration = body.settings?.durationSec === undefined ? 5 : body.settings.durationSec;
        if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 4 || duration > 15) {
          return c.json({ error: "营销影像视频时长需为 4–15 秒" }, 400);
        }
      }
      let settings = pickGenerationSettings(mediaType, body.settings);
      // Mini program quality tiers shift the requested resolution before
      // validation: 快速 drops every ratio one step, 自动/标准 only the wide
      // ones. Applied while `selectedModel` is still the slot id.
      if (mediaType === "image" && typeof settings.size === "string") {
        const cfg = miniprogramCfg(service);
        if (isMiniprogramImageSlot(selectedModel, cfg)) {
          settings = { ...settings, size: downshiftMiniprogramImageSize(selectedModel, settings.size as string) };
        }
      }
      const resolvedModel = mediaType === "image"
        ? await resolveImageModelId(service, userId, selectedModel)
        : selectedModel;
      if (mediaType === "image") {
        const finalized = finalizeImageSettings(settings, resolvedModel);
        if (finalized.error) return c.json({ error: finalized.error }, 400);
        settings = finalized.settings;
      }
      let videoReferences: Record<string, string | string[]> = {};
      if (mediaType === "video") {
        try {
          videoReferences = pickVideoReferenceInputs(body as Record<string, unknown>);
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : "invalid video references" }, 400);
        }
        settings = {
          ...settings,
          generate_audio: resolveVideoGenerateAudio(settings.generate_audio, videoReferences.reference_audio),
        };
      }
      const media = Array.isArray(body.media) ? body.media : undefined;
      if (mediaType === "image" && media && media.length > MAX_IMAGE_EDIT_REFERENCES) {
        return c.json({ error: `image editing supports at most ${MAX_IMAGE_EDIT_REFERENCES} reference images` }, 400);
      }
      if (mediaType === "video" && media) {
        const legacyImages = media.filter((m) => m?.type === "reference_image");
        if (legacyImages.length > 5) {
          return c.json({ error: "input_reference supports at most 5 references" }, 400);
        }
      }
      if (mediaType === "video") {
        const grokIssue = grokVideoIssue(resolvedModel, { ...settings, ...videoReferences, media });
        if (grokIssue) return c.json({ error: grokIssue }, 400);
      }
      const type = mediaType === "image" ? "image.generate" : "video.generate";

      // Quota pre-check (mirrors the /tasks route; shared billing source of truth).
      const modelId = mediaType === "image"
        ? "gpt-image-2"
        : resolvedModel ?? "kling-video-v3-omni";
      const cfg = makePricingLookup((id) => service.modelRegistry.getConfig(id), service.modelCatalog, mediaType)(modelId);
      const outputCount = mediaType === "image" ? Number(settings.n ?? 1) : billedVideoSeconds(settings.durationSec);
      const estimatedCost = cfg ? estimateCost(cfg, { outputCount }) : 0;
      const quota = await service.usageMeter.checkQuota(userId, estimatedCost);
      if (!quota.ok) return c.json({ error: quota.reason, code: quota.code, estimatedCost }, 402);

      // E-commerce scenes: check the request fits and rewrite it before anything is paid for or stored.
      // A failed or off-topic check sends no image request; the user simply sends again.
      let modelPrompts: string[] = [prompt];
      if (imageSceneNeedsReference(scene) && !media?.some((item) => item?.type === "reference_image")) {
        return c.json({ error: "请先上传产品图，再描述想换的场景", code: "IMAGE_SCENE_NEEDS_PRODUCT" }, 422);
      }
      if (scene !== "free") {
        let plan;
        try {
          const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(90_000)]);
          plan = await planImageScene(
            { scene, prompt, count: Number(settings.n ?? 1), referenceImages: media?.length ?? 0 },
            (system, user) => service.imageSceneText(system, user, userId, conv.agent_id, signal)
          );
        } catch (error) {
          // The reason and reply length are enough to tell a broken reply from a failed model call; the text itself is not logged.
          console.warn("[image.scene] plan failed", error instanceof ImageSceneError
            ? { scene, count: Number(settings.n ?? 1), errorType: "invalid_plan", reason: error.reason, replyLength: error.replyLength }
            : { scene, count: Number(settings.n ?? 1), errorType: (error as Error)?.name });
          return c.json({ error: "创作助手暂时无法整理这次描述，未提交出图，请稍后重试或改用自由创作", code: "IMAGE_SCENE_UNAVAILABLE" }, 503);
        }
        if (!plan.fits) return c.json({ error: plan.message, code: "IMAGE_SCENE_MISMATCH" }, 422);
        modelPrompts = plan.prompts;
        // Set scenes make one image per prompt; the white-background scene keeps the requested count.
        if (imageSceneUsesSet(scene)) settings = { ...settings, n: modelPrompts.length };
      }
      // 真实字体: a text model extracts the wording and describes the picture; prices, rates and dates it did not copy
      // from the request are emptied in code. Like a scene check, a failed plan sends no image request.
      let poster: PosterLayout | undefined;
      if (realText) {
        try {
          const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(90_000)]);
          const plan = await planPoster(
            { prompt, referenceImages: media?.length ?? 0 },
            (system, user) => service.imageSceneText(system, user, userId, conv.agent_id, signal)
          );
          const [width, height] = String(settings.size ?? "").split("x").map(Number);
          // The picture leaves room for the template that will really be used on this canvas shape.
          const template = width > 0 && height > 0 ? posterTemplateFor(plan.layout.template, width, height) : plan.layout.template;
          poster = { ...plan.layout, template };
          modelPrompts = [posterBackgroundPrompt(plan.background, template)];
        } catch (error) {
          console.warn("[image.poster] plan failed", error instanceof PosterPlanError
            ? { errorType: "invalid_plan", reason: error.reason, replyLength: error.replyLength }
            : { errorType: (error as Error)?.name });
          return c.json({ error: "创作助手暂时无法整理这次的文字，未提交出图，请稍后重试或关闭「真实字体」", code: "IMAGE_SCENE_UNAVAILABLE" }, 503);
        }
      }

      // Persist user message.
      const userMessageId = randomUUID();
      await service.db.addMessage(userMessageId, conversationId, "user", prompt);

      // Persist pending assistant generation message, born 'generating' (the
      // status column would otherwise default to 'completed'). Setting it at
      // insert time closes the race where a cache-hit worker completes the
      // message before a follow-up status write could land.
      const assistantMessageId = randomUUID();
      const supportsProgress = service.generationSupportsProgress[mediaType];
      const baseMeta = {
        kind: "generation", mediaType, prompt, settings, supportsProgress, ...(scene !== "free" ? { scene } : {}), ...(poster ? { poster } : {}),
      };
      await service.db.addMessage(assistantMessageId, conversationId, "assistant", "", {
        metadata: { ...baseMeta, status: "generating" },
        model: resolvedModel ?? modelId,
        status: "generating",
      });

      // Enqueue, then record the taskId on the message so a client that reloads
      // mid-generation can re-poll the task to resume progress / completion.
      // Identity fields are spread LAST: they are server-created and must win
      // over anything a client could try to smuggle into the payload.
      const taskId = await service.jobQueue.enqueue(
        type,
        {
          ...settings,
          ...videoReferences,
          ...(media ? { media } : {}),
          ...(resolvedModel ? { modelId: resolvedModel } : {}),
          prompt: modelPrompts[0],
          // Set scenes: one image per prompt, each its own model request. The card keeps showing the user's text.
          ...(modelPrompts.length > 1 ? { prompts: modelPrompts } : {}),
          ...(scene !== "free" ? { scene, displayPrompt: prompt } : {}),
          ...(poster ? { poster, displayPrompt: prompt } : {}),
          conversationId,
          assistantMessageId,
          requireUserModelKey: agentExtension(conv.agent_id)?.ownerKeyOnly === true,
        },
        userId
      );
      const metadata = { ...baseMeta, status: "generating", taskId };
      await service.db.updateMessageGeneration(
        assistantMessageId,
        { status: "generating", metadata },
        { conversationId, userId }
      );

      // Auto-title the conversation from the prompt (first message only, gated
      // inside generateTitle). The chat SSE path does this too; without it,
      // image/video conversations stay stuck on the "新对话" placeholder.
      try {
        // 本回合的模型是图片/视频模型，标题改用 LLM。ownerKeyOnly 的 Agent 仍严格
        // 限定为用户 TokenHub key，不允许标题请求回退环境模型。
        // The task is already running. Never hold its 202 response behind a
        // separate LLM request: a proxy timeout would look like submission failed.
        void service.generateTitle(conversationId, prompt, [], {
          userId,
          agentId: conv.agent_id,
          ...(isMiniprogramClient(c.req.header("x-lot-client"))
            ? { modelId: miniprogramCfg(service).llm }
            : {}),
        }).catch(() => {});
      } catch {
        // title generation is best-effort
      }

      return c.json(
        {
          userMessage: { id: userMessageId, role: "user", content: prompt },
          assistantMessage: { id: assistantMessageId, role: "assistant", status: "generating", metadata },
          taskId,
        },
        202
      );
    } finally {
      if (videoRunId) await service.db.releaseConversationRun(conversationId, videoRunId);
    }
  });

  // POST /:id/generations/:messageId/redownload — retry ONLY the download of a
  // generation whose vendor media succeeded but whose local download failed
  // (message left in 'download_failed' with a persisted sourceUrl). Re-fetches
  // that url without re-calling / re-billing the vendor. Reopens the message
  // and enqueues a `generation.redownload` job; returns the new taskId to poll.
  app.post("/:id/generations/:messageId/redownload", async (c) => {
    const userId = c.get("userId");
    const conversationId = c.req.param("id");
    const messageId = c.req.param("messageId");

    const msg = await service.db.getGenerationMessage(messageId, conversationId, userId);
    if (!msg) return c.json({ error: "Message not found" }, 404);
    const meta = msg.metadata;
    const metaStatus = (meta.status as string | undefined) ?? msg.status;
    const sourceUrl = meta.sourceUrl as string | undefined;
    // Multi-image generations keep every vendor url; older messages have only `sourceUrl`.
    const sourceUrls = Array.isArray(meta.sourceUrls) && meta.sourceUrls.every((url) => typeof url === "string" && url)
      ? { sourceUrls: meta.sourceUrls as string[] } : {};
    if (meta.kind !== "generation" || metaStatus !== "download_failed" || !sourceUrl) {
      return c.json({ error: "No failed download to retry" }, 409);
    }
    const mediaType = meta.mediaType === "image" ? "image" : "video";
    const settings = (meta.settings as Record<string, unknown> | undefined) ?? {};
    const prompt = (meta.prompt as string | undefined) ?? "";

    // Reopen before enqueuing (guarded on the 'download_failed' status) so a
    // double-click / concurrent retry only ever spawns one job.
    const reopened = await service.db.resetGenerationForRedownload(messageId, { conversationId, userId });
    if (!reopened) return c.json({ error: "Retry already in progress" }, 409);

    // The scene decides the role labels on the card, so it survives the retry.
    const scene = {
      ...(typeof meta.scene === "string" && meta.scene ? { scene: meta.scene } : {}),
      // 真实字体: the planned wording goes with the retry, so the downloaded picture is still typeset.
      ...(parsePosterLayout(meta.poster) ? { poster: meta.poster } : {}),
    };
    // Identity fields spread LAST so nothing stored in settings can override them.
    const taskId = await service.jobQueue.enqueue(
      "generation.redownload",
      { ...settings, mediaType, sourceUrl, ...sourceUrls, prompt, ...scene, conversationId, assistantMessageId: messageId },
      userId
    );
    const metadata = { kind: "generation", mediaType, prompt, settings, ...scene, status: "generating", taskId };
    await service.db.updateMessageGeneration(
      messageId,
      { status: "generating", metadata },
      { conversationId, userId }
    );
    return c.json({ taskId }, 202);
  });

  // POST /:id/generations/:messageId/compose — join the images of one finished image generation into a single
  // picture (长图 / 宫格 / 一大多小). Local work only: no model request, nothing metered. The picture is stored as a
  // new image asset and listed on the message, so asking for the same layout again returns the stored one.
  app.post("/:id/generations/:messageId/compose", async (c) => {
    const userId = c.get("userId");
    const conversationId = c.req.param("id");
    const messageId = c.req.param("messageId");
    const body = await c.req.json().catch(() => null) as { layout?: unknown; gap?: unknown } | null;
    const layout = parseComposeLayout(body?.layout);
    if (!layout) return c.json({ error: "unknown compose layout" }, 400);
    const gap = body?.gap === true;
    if (!deps.assets) return c.json({ error: "图片合成暂不可用" }, 503);

    const msg = await service.db.getGenerationMessage(messageId, conversationId, userId);
    if (!msg) return c.json({ error: "Message not found" }, 404);
    const meta = msg.metadata;
    const assets = Array.isArray(meta.assets) ? meta.assets as { url?: unknown; mime?: unknown }[] : [];
    const images = assets.filter((asset) => typeof asset?.mime === "string" && asset.mime.startsWith("image/"));
    if (meta.kind !== "generation" || meta.mediaType !== "image" || meta.status !== "completed" || images.length !== assets.length) {
      return c.json({ error: "只有已完成的图片可以合成" }, 409);
    }
    if ((meta.redo as { status?: unknown } | undefined)?.status === "running") return c.json({ error: "这组图正在重做，完成后再合成" }, 409);
    if (!composeLayoutFits(layout, images.length)) return c.json({ error: "这个版式不适用于当前图片数量" }, 400);
    const existing = storedComposites(meta.composites).find((item) => item.layout === layout && item.gap === gap);
    if (existing) return c.json({ composite: existing });

    // Every source must be this user's own stored output; the URL in the message is never fetched.
    const sources: Buffer[] = [];
    for (const image of images) {
      const key = outputStorageKey(image.url);
      const stored = key ? await service.db.getGeneratedByStorageKey(key) : null;
      if (!key || !stored || stored.user_id !== userId || !await deps.assets.exists(key)) {
        return c.json({ error: "原图已不存在，无法合成" }, 409);
      }
      sources.push(await deps.assets.get(key));
    }
    let composed;
    try {
      composed = await composeImages(sources, layout, { gap });
    } catch (error) {
      console.warn("[image.compose] failed", { messageId, layout, errorType: (error as Error)?.name });
      return c.json({ error: "图片合成失败，请稍后重试" }, 500);
    }
    const assetId = randomUUID();
    const key = `${assetId}.jpg`;
    const { url } = await deps.assets.put({ key, body: composed.body, contentType: composed.mime });
    await service.db.createAsset({
      id: assetId, taskId: typeof meta.taskId === "string" ? meta.taskId : null, userId, type: "image", storageKey: key, url,
      mime: composed.mime, sizeBytes: composed.body.byteLength, width: composed.width, height: composed.height,
    });
    const composite: GenerationComposite = { url, mime: composed.mime, layout, gap };
    if (!await service.db.appendGenerationComposite(messageId, composite, { conversationId, userId })) {
      return c.json({ error: "只有已完成的图片可以合成" }, 409);
    }
    return c.json({ composite });
  });

  // POST /:id/generations/:messageId/poster — 真实字体: change the wording (or template) of one typeset image and render
  // it again on its stored text-free background. Local work only: no model request, nothing metered. The picture is
  // stored under a key made from the background and the layout, so the same edit is rendered once.
  app.post("/:id/generations/:messageId/poster", async (c) => {
    const userId = c.get("userId");
    const conversationId = c.req.param("id");
    const messageId = c.req.param("messageId");
    const body = await c.req.json().catch(() => null) as { index?: unknown; fields?: unknown; template?: unknown } | null;
    const index = body?.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || !body?.fields || typeof body.fields !== "object") {
      return c.json({ error: "index and fields are required" }, 400);
    }
    if (!deps.assets) return c.json({ error: "改字暂不可用" }, 503);
    const msg = await service.db.getGenerationMessage(messageId, conversationId, userId);
    if (!msg) return c.json({ error: "Message not found" }, 404);
    const meta = msg.metadata;
    const stored = parsePosterLayout(Array.isArray(meta.posters) ? meta.posters[index] : undefined);
    const backgroundUrl = stored?.background?.url;
    if (meta.kind !== "generation" || meta.mediaType !== "image" || meta.status !== "completed" || !stored || !backgroundUrl) {
      return c.json({ error: "这张图不能改字" }, 409);
    }
    // The background must be this user's own stored output; the URL in the message is never fetched.
    const backgroundKey = outputStorageKey(backgroundUrl);
    const owned = backgroundKey ? await service.db.getGeneratedByStorageKey(backgroundKey) : null;
    if (!backgroundKey || !owned || owned.user_id !== userId || !await deps.assets.exists(backgroundKey)) {
      return c.json({ error: "背景图已不存在，无法改字" }, 409);
    }
    const layout = editPosterLayout(stored, { fields: body.fields, template: body.template });
    const key = `poster-${posterRenderKey(backgroundKey, layout)}.png`;
    const existing = await service.db.getGeneratedByStorageKey(key);
    if (existing && existing.user_id !== userId) return c.json({ error: "改字失败，请稍后重试" }, 500);
    let asset: { url: string; mime: string };
    let overflow = false;
    try {
      const rendered = await renderPoster(await deps.assets.get(backgroundKey), layout);
      overflow = rendered.overflow;
      if (existing && await deps.assets.exists(key)) {
        asset = { url: existing.url, mime: rendered.mime };
      } else {
        const { url } = await deps.assets.put({ key, body: rendered.body, contentType: rendered.mime });
        if (!existing) {
          await service.db.createAsset({
            id: randomUUID(), taskId: typeof meta.taskId === "string" ? meta.taskId : null, userId, type: "image", storageKey: key, url,
            mime: rendered.mime, sizeBytes: rendered.body.byteLength, width: rendered.width, height: rendered.height,
          });
        }
        asset = { url, mime: rendered.mime };
      }
    } catch (error) {
      console.warn("[image.poster] render failed", { messageId, errorType: (error as Error)?.name });
      return c.json({ error: "改字失败，请稍后重试" }, 500);
    }
    const poster: PosterLayout = overflow ? { ...layout, overflow: true } : layout;
    // Row lock: the edit depends on what is on the message now. Composites were joined from the old picture.
    const saved = await service.db.updateGenerationMetadata(messageId, { conversationId, userId }, (current) => {
      const assets = Array.isArray(current.assets) ? [...current.assets] : [];
      const posters = Array.isArray(current.posters) ? [...current.posters] : [];
      const same = (posters[index] as { background?: { url?: unknown } } | undefined)?.background?.url === backgroundUrl;
      if (current.status !== "completed" || index >= assets.length || !same) return null;
      assets[index] = asset;
      posters[index] = poster;
      const { composites: _composites, ...rest } = current;
      return { ...rest, assets, posters };
    });
    if (!saved) return c.json({ error: "这张图已变化，请刷新后再改字" }, 409);
    return c.json({ index, asset, poster });
  });

  // POST /:id/generations/:messageId/export — 打包下载: this generation's images and composites in one zip, as stored
  // (`original`) or resized for a selling platform. Names come from the card (roles / layouts) and are sanitized here.
  // Local work only: no model request, nothing metered.
  app.post("/:id/generations/:messageId/export", async (c) => {
    const userId = c.get("userId");
    const conversationId = c.req.param("id");
    const messageId = c.req.param("messageId");
    const body = await c.req.json().catch(() => null) as { preset?: unknown; names?: unknown; compositeNames?: unknown } | null;
    const preset = parseExportPreset(body?.preset);
    if (!preset) return c.json({ error: "unknown export preset" }, 400);
    if (!deps.assets) return c.json({ error: "打包下载暂不可用" }, 503);
    const msg = await service.db.getGenerationMessage(messageId, conversationId, userId);
    if (!msg) return c.json({ error: "Message not found" }, 404);
    const meta = msg.metadata;
    const assets = Array.isArray(meta.assets) ? meta.assets as { url?: unknown; mime?: unknown }[] : [];
    if (meta.kind !== "generation" || meta.mediaType !== "image" || meta.status !== "completed" || !assets.length
      || assets.some((asset) => typeof asset?.mime !== "string" || !asset.mime.startsWith("image/"))) {
      return c.json({ error: "只有已完成的图片可以打包下载" }, 409);
    }
    const names = Array.isArray(body?.names) ? body.names : [];
    const compositeNames = Array.isArray(body?.compositeNames) ? body.compositeNames : [];
    const wanted = [
      ...assets.map((asset, index) => ({
        url: asset.url, name: safeExportName(names[index], `图片_${String(index + 1).padStart(2, "0")}`), detail: false,
      })),
      ...storedComposites(meta.composites).map((item, index) => ({
        url: item.url, name: safeExportName(compositeNames[index], `合成_${index + 1}`), detail: item.layout === "vertical",
      })),
    ];
    // Every file must be this user's own stored output; the URLs in the message are never fetched.
    const sources: ExportSource[] = [];
    for (const item of wanted) {
      const key = outputStorageKey(item.url);
      const stored = key ? await service.db.getGeneratedByStorageKey(key) : null;
      if (!key || !stored || stored.user_id !== userId || !await deps.assets.exists(key)) {
        return c.json({ error: "原图已不存在，无法打包" }, 409);
      }
      sources.push({ name: item.name, body: await deps.assets.get(key), ext: key.split(".").pop() || "png", detail: item.detail });
    }
    let zip: Buffer;
    try {
      zip = await buildExportZip(sources, preset);
    } catch (error) {
      console.warn("[image.export] failed", { messageId, preset, errorType: (error as Error)?.name });
      return c.json({ error: "打包失败，请稍后重试" }, 500);
    }
    return new Response(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${preset === "original" ? "images" : preset}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  });

  // POST /:id/generations/:messageId/redo — 重做 one image of a finished set ({ index }) or 补齐 the images the set is
  // missing ({ missing: true }). Uses the original prompts and settings; the result goes back into the same message.
  // Started only by the user and billed like any image; nothing is ever sent again on its own.
  app.post("/:id/generations/:messageId/redo", async (c) => {
    const userId = c.get("userId");
    const conversationId = c.req.param("id");
    const messageId = c.req.param("messageId");
    const body = await c.req.json().catch(() => null) as { index?: unknown; missing?: unknown } | null;
    const owner = { conversationId, userId };

    const msg = await service.db.getGenerationMessage(messageId, conversationId, userId);
    if (!msg) return c.json({ error: "Message not found" }, 404);
    const meta = msg.metadata;
    const scene = parseImageScene(meta.scene);
    if (meta.kind !== "generation" || meta.mediaType !== "image" || meta.status !== "completed" || !scene || !imageSceneUsesSet(scene)) {
      return c.json({ error: "只有已完成的产品套图和主副图可以重做" }, 409);
    }
    if ((meta.redo as { status?: unknown } | undefined)?.status === "running") return c.json({ error: "这组图正在重做，请稍候" }, 409);
    const task = typeof meta.taskId === "string" ? await service.db.getTask(meta.taskId) : null;
    const input = task && task.user_id === userId && task.input && typeof task.input === "object" ? task.input as Record<string, unknown> : null;
    const prompts = Array.isArray(input?.prompts) && input.prompts.every((p) => typeof p === "string" && p)
      ? input.prompts as string[]
      : typeof input?.prompt === "string" && input.prompt ? [input.prompt] : [];
    if (!input || !prompts.length) return c.json({ error: "原始任务已不存在，无法重做" }, 409);
    const assets = Array.isArray(meta.assets) ? meta.assets as { url?: unknown }[] : [];

    let indexes: number[];
    if (body?.missing === true) {
      indexes = Array.from({ length: Math.max(0, prompts.length - assets.length) }, (_, i) => assets.length + i);
      if (!indexes.length) return c.json({ error: "这组图没有缺少的图片" }, 409);
    } else if (Number.isInteger(body?.index) && (body?.index as number) >= 0 && (body?.index as number) < Math.min(assets.length, prompts.length)) {
      indexes = [body?.index as number];
    } else {
      return c.json({ error: "index or missing is required" }, 400);
    }

    const cfg = makePricingLookup((id) => service.modelRegistry.getConfig(id), service.modelCatalog, "image")("gpt-image-2");
    const estimatedCost = cfg ? estimateCost(cfg, { outputCount: indexes.length }) : 0;
    const quota = await service.usageMeter.checkQuota(userId, estimatedCost);
    if (!quota.ok) return c.json({ error: quota.reason, code: quota.code, estimatedCost }, 402);

    // The user's own reference keeps the product; without one, another image of the set does.
    const media = Array.isArray(input.media) ? (input.media as { type?: unknown; url?: unknown }[]).filter((m) => m?.type === "reference_image") : [];
    const keep = assets.find((asset, index) => !indexes.includes(index) && typeof asset?.url === "string");
    const setReference = !media.length && typeof keep?.url === "string" ? keep.url : undefined;

    const claimed = await service.db.updateGenerationMetadata(messageId, owner, (current) =>
      current.status === "completed" && (current.redo as { status?: unknown } | undefined)?.status !== "running"
        ? { ...current, redo: { status: "running", indexes } } : null);
    if (!claimed) return c.json({ error: "这组图正在重做，请稍候" }, 409);
    let taskId: string;
    try {
      // Identity fields spread LAST: only the server writes them.
      taskId = await service.jobQueue.enqueue(IMAGE_REDO_TASK, {
        ...Object.fromEntries(["size", "quality", "ratio", "resolution", "modelId", "requireUserModelKey"].map((key) => [key, input[key]])),
        n: 1,
        ...(media.length ? { media } : {}),
        ...(setReference ? { setReference } : {}),
        prompts: indexes.map((index) => prompts[index]),
        indexes,
        redoMessageId: messageId,
        conversationId,
      }, userId);
    } catch (error) {
      await service.db.updateGenerationMetadata(messageId, owner, (current) => {
        const { redo: _redo, ...rest } = current;
        return rest;
      });
      throw error;
    }
    const redo = { status: "running", indexes, taskId };
    await service.db.updateGenerationMetadata(messageId, owner, (current) =>
      (current.redo as { status?: unknown } | undefined)?.status === "running" && !(current.redo as { taskId?: unknown }).taskId
        ? { ...current, redo } : null);
    return c.json({ taskId, redo }, 202);
  });

  return app;
}

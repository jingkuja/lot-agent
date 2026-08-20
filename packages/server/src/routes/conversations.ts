import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { estimateCost, MAX_IMAGE_EDIT_REFERENCES } from "@lot-agent/core";
import type { AgentService } from "../services/agent-service.js";
import { agentEventToSse } from "../services/sse-adapter.js";
import { attachmentKind, type AttachmentRef } from "../services/attachment-extractor.js";
import type { KnowledgeBaseRef } from "../services/rag-client.js";
import { billedVideoSeconds, pickGenerationSettings, pickVideoReferenceInputs } from "../generation/input.js";

type Variables = { userId: string };

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
const RUN_LEASE_STALE_MS = 600_000;

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

export function createConversationRoutes(service: AgentService): Hono {
  const app = new Hono<{ Variables: Variables }>();

  // List conversations — scoped to current user, keyset-paginated (latest
  // first) over updated_at. ?limit=20&cursor=<id> ; the cursor is the id of the
  // last row from the previous page. Omitting limit returns the full list
  // (back-compat).
  app.get("/", async (c) => {
    const userId = c.get("userId");
    const limitRaw = c.req.query("limit");
    if (limitRaw == null) {
      const conversations = await service.db.listConversations(userId);
      return c.json(conversations);
    }
    const limit = Number(limitRaw);
    if (!Number.isFinite(limit)) {
      return c.json({ error: "limit must be a number" }, 400);
    }
    const clamped = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const cursorId = c.req.query("cursor") || undefined;
    const items = await service.db.listConversations(userId, { limit: clamped, cursorId });
    // nextCursor: id of the last row when a full page came back (more may
    // exist); null once a short page signals the end.
    const nextCursor =
      items.length === clamped ? (items[items.length - 1] as { id: string }).id : null;
    return c.json({ items, nextCursor });
  });

  // Create conversation — owned by current user
  app.post("/", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json<{ title?: string; agentId?: string; featureScope?: string }>().catch(() => ({}));
    const id = randomUUID();
    const title = body.title ?? "新对话";
    const model =
      service["llmConfig"].default === "openai"
        ? service["llmConfig"].openai.model
        : service["llmConfig"].anthropic.model;
    const provider = service["llmConfig"].default;
    const agentId = body.agentId ?? "general";
    const allowedScopes = new Set(["marketing-materials", "customer-profile", "opportunity-advisor", "customer-acquisition"]);
    const featureScope = agentId === "digital_employee" && body.featureScope && allowedScopes.has(body.featureScope)
      ? body.featureScope
      : undefined;
    const conversation = await service.db.createConversation(
      id, title, model, provider, agentId, userId,
      featureScope ? { digitalEmployeeFeatureScope: featureScope } : undefined
    );
    return c.json(conversation, 201);
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
          : m.tool_calls,
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
    const body = await c.req.json<{ knowledgeBaseIds?: unknown }>().catch(() => ({}));
    if (!validateKnowledgeBaseIds(body.knowledgeBaseIds)) {
      return c.json({ error: `invalid knowledgeBaseIds (max ${MAX_KNOWLEDGE_BASES})` }, 400);
    }
    if (body.knowledgeBaseIds.length && conversation.agent_id !== "general") {
      return c.json({ error: "knowledge bases are only available in the general assistant" }, 400);
    }
    try {
      const knowledgeBases = await service.resolveKnowledgeBases(userId, body.knowledgeBaseIds);
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

    const body = await c.req.json<{
      content: string;
      attachments?: AttachmentRef[];
      modelId?: string;
      knowledgeBaseIds?: string[];
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
        knowledgeBases = await service.resolveKnowledgeBases(userId, knowledgeBaseIds);
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : "知识库不可用" },
          502
        );
      }
    }
    if (suppliedKnowledgeBaseIds !== undefined) {
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
    const runId = randomUUID();
    const claimed = await service.db.claimConversationRun(id, runId, RUN_LEASE_STALE_MS);
    if (!claimed) {
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
        const releaseLease = async () => {
          if (leaseReleased) return;
          await service.db.releaseConversationRun(id, runId);
          leaseReleased = true;
        };

        // Open the stream immediately with an SSE comment so the client (and
        // any reverse proxy) flushes the connection before the first token,
        // rather than holding everything until the response completes.
        controller.enqueue(encoder.encode(": open\n\n"));

        try {
          for await (const event of service.streamAgentResponse(
            id,
            body.content ?? "",
            conversation.agent_id,
            userId,
            attachments,
            c.req.raw.signal,
            { modelId: body.modelId, knowledgeBases }
          )) {
            send(agentEventToSse(event));
          }
          // Release the server-side turn first, then tell the client it may
          // unlock. The title is a whole extra LLM round-trip and deliberately
          // runs after both sides agree that the conversation turn has ended.
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
              { userId, modelId: body.modelId }
            );
            if (title) send({ type: "title", title });
          } catch {
            // title generation is best-effort
          }
        } catch (error) {
          send({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
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

export function createGenerationRoutes(service: AgentService) {
  const app = new Hono<{ Variables: GenVariables }>();

  app.post("/:id/generations", async (c) => {
    const userId = c.get("userId");
    const conversationId = c.req.param("id");

    const conv = await service.db.getConversation(conversationId);
    if (!conv || (conv as { user_id?: string }).user_id !== userId) {
      return c.json({ error: "Conversation not found" }, 404);
    }

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
    // Client settings pass a per-media whitelist so identity fields
    // (conversationId/assistantMessageId/userId) can never ride along.
    const settings = pickGenerationSettings(mediaType, body.settings);
    let videoReferences: Record<string, string | string[]> = {};
    if (mediaType === "video") {
      try {
        videoReferences = pickVideoReferenceInputs(body as Record<string, unknown>);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "invalid video references" }, 400);
      }
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
    const type = mediaType === "image" ? "image.generate" : "video.generate";

    // Quota pre-check (mirrors the /tasks route; shared billing source of truth).
    const modelId = mediaType === "image" ? "gpt-image-2" : "kling-standard";
    const cfg = service.modelRegistry.getConfig(modelId);
    const outputCount = mediaType === "image" ? Number(settings.n ?? 1) : billedVideoSeconds(settings.durationSec);
    const estimatedCost = cfg ? estimateCost(cfg, { outputCount }) : 0;
    const quota = await service.usageMeter.checkQuota(userId, estimatedCost);
    if (!quota.ok) return c.json({ error: quota.reason, estimatedCost }, 402);

    // Persist user message.
    const userMessageId = randomUUID();
    await service.db.addMessage(userMessageId, conversationId, "user", prompt);

    // Persist pending assistant generation message, born 'generating' (the
    // status column would otherwise default to 'completed'). Setting it at
    // insert time closes the race where a cache-hit worker completes the
    // message before a follow-up status write could land.
    const assistantMessageId = randomUUID();
    const supportsProgress = service.generationSupportsProgress[mediaType];
    const baseMeta = { kind: "generation", mediaType, prompt, settings, supportsProgress };
    await service.db.addMessage(assistantMessageId, conversationId, "assistant", "", {
      metadata: { ...baseMeta, status: "generating" },
      model: modelId,
      status: "generating",
    });

    // Enqueue, then record the taskId on the message so a client that reloads
    // mid-generation can re-poll the task to resume progress / completion.
    const selectedModel = typeof body.model === "string" && body.model ? body.model : undefined;
    // Identity fields are spread LAST: they are server-created and must win
    // over anything a client could try to smuggle into the payload.
    const taskId = await service.jobQueue.enqueue(
      type,
      {
        ...settings,
        ...videoReferences,
        ...(media ? { media } : {}),
        ...(selectedModel ? { modelId: selectedModel } : {}),
        prompt,
        conversationId,
        assistantMessageId,
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
    let title: string | null = null;
    try {
      // 只传 userId:本回合的模型是图片/视频模型,做不了文字总结,
      // 让 generateTitle 回落到模型目录第一个 LLM(无目录时才用 env 默认)。
      title = await service.generateTitle(conversationId, prompt, [], { userId });
    } catch {
      // title generation is best-effort
    }

    return c.json(
      {
        userMessage: { id: userMessageId, role: "user", content: prompt },
        assistantMessage: { id: assistantMessageId, role: "assistant", status: "generating", metadata },
        taskId,
        ...(title ? { title } : {}),
      },
      202
    );
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

    // Identity fields spread LAST so nothing stored in settings can override them.
    const taskId = await service.jobQueue.enqueue(
      "generation.redownload",
      { ...settings, mediaType, sourceUrl, prompt, conversationId, assistantMessageId: messageId },
      userId
    );
    const metadata = { kind: "generation", mediaType, prompt, settings, status: "generating", taskId };
    await service.db.updateMessageGeneration(
      messageId,
      { status: "generating", metadata },
      { conversationId, userId }
    );
    return c.json({ taskId }, 202);
  });

  return app;
}

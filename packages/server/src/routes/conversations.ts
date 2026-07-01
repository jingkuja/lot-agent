import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { AgentService } from "../services/agent-service.js";
import { agentEventToSse } from "../services/sse-adapter.js";
import { attachmentKind, type AttachmentRef } from "../services/attachment-extractor.js";

type Variables = { userId: string };

/** Server-side cap (the InputBox MAX_FILES=5 is only a client hint). */
const MAX_ATTACHMENTS = 5;

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
    const body = await c.req.json<{ title?: string; agentId?: string }>().catch(() => ({}));
    const id = randomUUID();
    const title = body.title ?? "新对话";
    const model =
      service["llmConfig"].default === "openai"
        ? service["llmConfig"].openai.model
        : service["llmConfig"].anthropic.model;
    const provider = service["llmConfig"].default;
    const agentId = body.agentId ?? "general";
    const conversation = await service.db.createConversation(id, title, model, provider, agentId, userId);
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

    await service.db.deleteMessagesFromAndAfter(id, body.afterMessageId);
    return c.json({ ok: true });
  });

  // Send message — returns SSE stream, ownership check
  app.post("/:id/messages", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const conversation = await service.db.getConversation(id);
    if (!conversation || conversation.user_id !== userId) {
      return c.json({ error: "Not found" }, 404);
    }

    const body = await c.req.json<{ content: string; attachments?: AttachmentRef[]; modelId?: string }>();
    if (!body.content && !(body.attachments && body.attachments.length)) {
      return c.json({ error: "content or attachments required" }, 400);
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
      });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: Record<string, unknown>) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
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
            { modelId: body.modelId }
          )) {
            send(agentEventToSse(event));
          }
          // Summarize + persist the conversation title (first message only) and
          // push it to the client so the sidebar updates live, no refresh.
          try {
            const title = await service.generateTitle(
              id,
              body.content ?? "",
              attachments
            );
            if (title) send({ type: "title", title });
          } catch {
            // title generation is best-effort
          }
          send({ type: "stream_end" });
        } catch (error) {
          send({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
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

    let body: { prompt?: string; mediaType?: "image" | "video"; settings?: Record<string, unknown>; media?: { type: string; url: string }[]; model?: string };
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
    const settings = body.settings ?? {};
    const media = Array.isArray(body.media) ? body.media : undefined;
    const type = mediaType === "image" ? "image.generate" : "video.generate";

    // Quota pre-check (mirrors the /tasks route).
    const modelId = mediaType === "image" ? "gpt-image-2-token" : "kling-standard";
    const unit = service.modelRegistry.getConfig(modelId)?.unitPrice ?? 0;
    const durationSec = Number(settings.durationSec ?? 5);
    const estimatedCost = mediaType === "image" ? unit * Number(settings.n ?? 1) : unit * durationSec;
    const quota = await service.usageMeter.checkQuota(userId, estimatedCost);
    if (!quota.ok) return c.json({ error: quota.reason, estimatedCost }, 402);

    // Persist user message.
    const userMessageId = randomUUID();
    await service.db.addMessage(userMessageId, conversationId, "user", prompt);

    // Persist pending assistant generation message (status forced to
    // 'generating'; the DB column defaults to 'completed').
    const assistantMessageId = randomUUID();
    const supportsProgress = service.generationSupportsProgress[mediaType];
    const baseMeta = { kind: "generation", mediaType, prompt, settings, supportsProgress };
    await service.db.addMessage(assistantMessageId, conversationId, "assistant", "", {
      metadata: { ...baseMeta, status: "generating" },
      model: modelId,
    });

    // Enqueue, then record the taskId on the message so a client that reloads
    // mid-generation can re-poll the task to resume progress / completion.
    const selectedModel = typeof body.model === "string" && body.model ? body.model : undefined;
    const taskId = await service.jobQueue.enqueue(
      type,
      {
        prompt,
        conversationId,
        assistantMessageId,
        ...settings,
        ...(media ? { media } : {}),
        ...(selectedModel ? { modelId: selectedModel } : {}),
      },
      userId
    );
    const metadata = { ...baseMeta, status: "generating", taskId };
    await service.db.updateMessageGeneration(assistantMessageId, { status: "generating", metadata });

    // Auto-title the conversation from the prompt (first message only, gated
    // inside generateTitle). The chat SSE path does this too; without it,
    // image/video conversations stay stuck on the "新对话" placeholder.
    let title: string | null = null;
    try {
      title = await service.generateTitle(conversationId, prompt, []);
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

  return app;
}

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { AgentService } from "../services/agent-service.js";
import { agentEventToSse } from "../services/sse-adapter.js";

type Variables = { userId: string };

export function createConversationRoutes(service: AgentService): Hono {
  const app = new Hono<{ Variables: Variables }>();

  // List conversations — scoped to current user
  app.get("/", async (c) => {
    const userId = c.get("userId");
    const conversations = await service.db.listConversations(userId);
    return c.json(conversations);
  });

  // Create conversation — owned by current user
  app.post("/", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json<{ title?: string; agentId?: string }>().catch(() => ({}));
    const id = randomUUID();
    const title = body.title ?? "New Chat";
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

    const body = await c.req.json<{ content: string }>();
    if (!body.content) {
      return c.json({ error: "content is required" }, 400);
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
            body.content,
            conversation.agent_id,
            userId
          )) {
            send(agentEventToSse(event));
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

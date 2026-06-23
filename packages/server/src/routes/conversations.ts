import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { AgentService } from "../services/agent-service.js";

export function createConversationRoutes(service: AgentService): Hono {
  const app = new Hono();

  // List conversations
  app.get("/", async (c) => {
    const conversations = await service.db.listConversations();
    return c.json(conversations);
  });

  // Create conversation
  app.post("/", async (c) => {
    const body = await c.req.json<{ title?: string; agentId?: string }>().catch(() => ({}));
    const id = randomUUID();
    const title = body.title ?? "New Chat";
    const model =
      service["llmConfig"].default === "openai"
        ? service["llmConfig"].openai.model
        : service["llmConfig"].anthropic.model;
    const provider = service["llmConfig"].default;
    const agentId = body.agentId ?? "general";
    const conversation = await service.db.createConversation(id, title, model, provider, agentId);
    return c.json(conversation, 201);
  });

  // Get conversation with messages
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const conversation = await service.db.getConversation(id);
    if (!conversation) return c.json({ error: "Not found" }, 404);
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

  // Delete conversation (soft delete)
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await service.db.deleteConversation(id);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  // Regenerate: delete messages after a given message (used before re-sending)
  app.post("/:id/regenerate", async (c) => {
    const id = c.req.param("id");
    const conversation = await service.db.getConversation(id);
    if (!conversation) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<{ afterMessageId: string }>();
    if (!body.afterMessageId) {
      return c.json({ error: "afterMessageId is required" }, 400);
    }

    await service.db.deleteMessagesFromAndAfter(id, body.afterMessageId);
    return c.json({ ok: true });
  });

  // Send message — returns SSE stream
  app.post("/:id/messages", async (c) => {
    const id = c.req.param("id");
    const conversation = await service.db.getConversation(id);
    if (!conversation) return c.json({ error: "Not found" }, 404);

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

        try {
          const resolvedAgentId = await service.db.getConversationAgentId(id);
          for await (const event of service.streamAgentResponse(
            id,
            body.content,
            resolvedAgentId
          )) {
            send(event);
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
      },
    });
  });

  return app;
}

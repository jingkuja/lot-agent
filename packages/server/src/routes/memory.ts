import { Hono } from "hono";
import { AgentMemoryStore } from "@lot-agent/core";
import type { AgentService } from "../services/agent-service.js";

type Variables = { userId: string };

export function createMemoryRoutes(service: AgentService): Hono {
  const app = new Hono<{ Variables: Variables }>();

  function getMemory(userId: string): AgentMemoryStore {
    return new AgentMemoryStore({ persistent: service.pgAdapter, userId });
  }

  // List user memories
  app.get("/", async (c) => {
    const memory = getMemory(c.get("userId"));
    const entries = await memory.listUserMemory();
    return c.json(entries);
  });

  // Search user memories
  app.get("/search", async (c) => {
    const memory = getMemory(c.get("userId"));
    const query = c.req.query("q") ?? "";
    if (!query) return c.json([]);
    const entries = await memory.searchUserMemory(query);
    return c.json(entries);
  });

  // Get a specific memory
  app.get("/:key", async (c) => {
    const memory = getMemory(c.get("userId"));
    const key = c.req.param("key");
    const value = await memory.getUserMemory(key);
    if (value === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ key, value });
  });

  // Set a user memory
  app.post("/:key", async (c) => {
    const memory = getMemory(c.get("userId"));
    const key = c.req.param("key");
    const body = await c.req.json<{ value: string }>();
    if (!body.value) return c.json({ error: "value is required" }, 400);
    await memory.setUserMemory(key, body.value);
    return c.json({ key, value: body.value });
  });

  // Delete a user memory
  app.delete("/:key", async (c) => {
    const memory = getMemory(c.get("userId"));
    const key = c.req.param("key");
    await memory.delete("user", key);
    return c.json({ ok: true });
  });

  // Get session memory for a conversation (read-only)
  app.get("/session/dump", async (c) => {
    const conversationId = c.req.query("conversationId");
    if (!conversationId) return c.json([]);
    const memory = new AgentMemoryStore({
      sessionBackend: service.sessionBackend,
      conversationId,
    });
    await memory.hydrate();
    return c.json(memory.dump("session"));
  });

  return app;
}

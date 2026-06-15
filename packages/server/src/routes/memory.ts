import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createMemoryRoutes(service: AgentService): Hono {
  const app = new Hono();

  // List user memories
  app.get("/", async (c) => {
    const entries = await service.memory.listUserMemory();
    return c.json(entries);
  });

  // Search user memories
  app.get("/search", async (c) => {
    const query = c.req.query("q") ?? "";
    if (!query) return c.json([]);
    const entries = await service.memory.searchUserMemory(query);
    return c.json(entries);
  });

  // Get a specific memory
  app.get("/:key", async (c) => {
    const key = c.req.param("key");
    const value = await service.memory.getUserMemory(key);
    if (value === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ key, value });
  });

  // Set a user memory
  app.post("/:key", async (c) => {
    const key = c.req.param("key");
    const body = await c.req.json<{ value: string }>();
    if (!body.value) return c.json({ error: "value is required" }, 400);
    await service.memory.setUserMemory(key, body.value);
    return c.json({ key, value: body.value });
  });

  // Delete a user memory
  app.delete("/:key", async (c) => {
    const key = c.req.param("key");
    await service.memory.delete("user", key);
    return c.json({ ok: true });
  });

  // Get session memory (read-only)
  app.get("/session/dump", (c) => {
    const entries = service.memory.dump("session");
    return c.json(entries);
  });

  return app;
}

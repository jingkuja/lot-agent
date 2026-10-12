import { Hono } from "hono";
import type { LocalToolCapabilities } from "@lot-agent/core/desktop";
import type { AgentService } from "../services/agent-service.js";

export function createDesktopToolRoutes(service: AgentService) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("/:id/desktop-tools/*", async (c, next) => {
    const conversation = await service.db.getConversation(c.req.param("id")!);
    if (!conversation || conversation.user_id !== c.get("userId")) return c.json({ error: "Not found" }, 404);
    if (conversation.agent_id !== "general") return c.json({ error: "Local tools require the general assistant" }, 403);
    await next();
  });
  app.post("/:id/desktop-tools/session", async c => {
    let capabilities: LocalToolCapabilities | undefined;
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (c.req.raw.body) for await (const chunk of c.req.raw.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > 1024) return c.json({ error: "Registration too large" }, 413);
      chunks.push(chunk);
    }
    if (bytes) {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return c.json({ error: "Invalid desktop capabilities" }, 400); }
      if (!body || Array.isArray(body) || body.version !== 2 || !["bash", "powershell", null].includes(body.shell)
        || Object.keys(body).some(key => !["version", "shell"].includes(key))) return c.json({ error: "Invalid desktop capabilities" }, 400);
      capabilities = { version: 2, shell: body.shell };
    }
    try { return c.json({ capability: service.desktopTools.create(c.get("userId"), c.req.param("id"), capabilities), version: 2 }); }
    catch { return c.json({ error: "Desktop session limit reached" }, 429); }
  });
  app.get("/:id/desktop-tools/session", c => {
    const result = service.desktopTools.poll(c.req.header("X-Lot-Desktop-Capability") ?? "", c.get("userId"), c.req.param("id"));
    return result ? c.json(result) : c.json({ error: "Desktop session unavailable" }, 404);
  });
  app.delete("/:id/desktop-tools/session", c => {
    service.desktopTools.revoke(c.req.header("X-Lot-Desktop-Capability") ?? "", c.get("userId"), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/:id/desktop-tools/result", async c => {
    // Bound the body before JSON parsing, including chunked requests.
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (c.req.raw.body) for await (const chunk of c.req.raw.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > 300_000) return c.json({ error: "Result too large" }, 413);
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return c.json({ error: "Invalid result" }, 400); }
    if (typeof body?.id !== "string" || typeof body?.result?.content !== "string" || body.result.content.length > 60000 || (body.result.isError !== undefined && typeof body.result.isError !== "boolean")) return c.json({ error: "Invalid result" }, 400);
    const allowedKinds = ["permission", "validation", "not_found", "cancelled", "unknown_outcome", "unknown", "timeout"];
    if (body.result.errorKind !== undefined && !allowedKinds.includes(body.result.errorKind)) return c.json({ error: "Invalid error kind" }, 400);
    const ok = service.desktopTools.complete(c.req.header("X-Lot-Desktop-Capability") ?? "", c.get("userId"), c.req.param("id"), body.id, { content: body.result.content, isError: body.result.isError, errorKind: body.result.errorKind });
    return ok ? c.json({ ok }) : c.json({ error: "Stale or unauthorized operation" }, 409);
  });
  return app;
}

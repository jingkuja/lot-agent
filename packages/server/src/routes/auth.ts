import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";
import { generateRsaKeypair } from "../auth/rsa.js";
import { toPublicUser } from "../db/user-sanitize.js";

// Ephemeral per-process keypair used to decrypt login passwords.
const keypair = generateRsaKeypair();

const LOGIN_FAIL = "登录失败，请稍后再试或者联系管理员";

export function createAuthRoutes(service: AgentService): Hono {
  const app = new Hono();

  // GET /public-key — public; browser fetches this to encrypt the password.
  app.get("/public-key", (c) => c.json({ publicKey: keypair.publicKeyPem }));

  // GET /mode — public. Lets the web decide whether to skip login before it has
  // a token: in debug mode it returns the seeded debug user to enter directly.
  app.get("/mode", async (c) => {
    if (!service.debug || !service.debugUserId) {
      return c.json({ debug: false, user: null });
    }
    const user = await service.db.getUserById(service.debugUserId);
    return c.json({ debug: true, user: user ? toPublicUser(user) : null });
  });

  // POST /login — public. RSA-encrypted password → tokenhub → local session.
  app.post("/login", async (c) => {
    let body: { username?: string; encryptedPassword?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const { username, encryptedPassword } = body;
    if (!username || !encryptedPassword) {
      return c.json({ error: LOGIN_FAIL }, 401);
    }
    try {
      const password = keypair.decrypt(encryptedPassword);
      const result = await service.tokenhub.login(username, password);
      const user = await service.db.upsertUserByExternalId({
        externalUserId: result.userId,
        username: result.name,
        apiKeys: result.apiKeys,
      });
      const token = await service.sessions.createSession(user.id);
      return c.json({ token, user: toPublicUser(user) });
    } catch {
      // Any failure — decrypt, tokenhub network/auth — is collapsed to one message.
      return c.json({ error: LOGIN_FAIL }, 401);
    }
  });

  // POST /token-login — public. Exchanges a tokenhub-issued JWT (delivered via a
  // `?token=` deep link) for a local session, so users linked in from tokenhub
  // skip the manual login form.
  app.post("/token-login", async (c) => {
    let body: { token?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const token = body.token?.trim();
    if (!token) {
      return c.json({ error: LOGIN_FAIL }, 401);
    }
    try {
      const result = await service.tokenhub.tokenLogin(token);
      const user = await service.db.upsertUserByExternalId({
        externalUserId: result.userId,
        username: result.name,
        apiKeys: result.apiKeys,
      });
      const sessionToken = await service.sessions.createSession(user.id);
      return c.json({ token: sessionToken, user: toPublicUser(user) });
    } catch {
      // Same opacity as /login — any tokenhub/network failure collapses to one message.
      return c.json({ error: LOGIN_FAIL }, 401);
    }
  });

  // POST /logout — best-effort, no auth check needed
  app.post("/logout", async (c) => {
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      if (token) {
        await service.sessions.revoke(token).catch(() => {});
      }
    }
    return c.json({ ok: true });
  });

  // GET /me — requires valid Bearer token
  app.get("/me", async (c) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const token = authHeader.slice("Bearer ".length).trim();
    const s = await service.sessions.resolve(token);
    if (!s) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const user = await service.db.getUserById(s.userId);
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json(toPublicUser(user));
  });

  return app;
}

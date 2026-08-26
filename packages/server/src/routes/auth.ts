import { Hono } from "hono";
import { logger } from "@lot-agent/core";
import type { AgentService } from "../services/agent-service.js";
import { generateRsaKeypair } from "../auth/rsa.js";
import { toPublicUser } from "../db/user-sanitize.js";
import { randomUUID } from "node:crypto";
import { TokenhubClientError } from "../tokenhub/client.js";

// Ephemeral per-process keypair used to decrypt login passwords.
const keypair = generateRsaKeypair();

const LOGIN_FAIL = "登录失败，请稍后再试或者联系管理员";

const CONTACT_ERROR_MESSAGES: Record<string, string> = {
  email_taken: "该邮箱已被其他用户使用",
  phone_taken: "该手机号已被其他用户使用",
  invalid_email: "请输入有效的邮箱地址",
  invalid_phone: "请输入有效的中国大陆手机号",
  phone_not_registered: "该手机号尚未注册",
  sms_not_configured: "短信服务尚未配置，请联系管理员",
  email_code_invalid: "邮箱验证码错误或已过期",
  phone_code_invalid: "手机验证码错误或已过期",
  user_exists: "该用户名已被使用",
};

function contactError(err: unknown, fallback: string): { message: string; code?: string } {
  const code = err instanceof TokenhubClientError ? err.code : undefined;
  return { message: code ? CONTACT_ERROR_MESSAGES[code] ?? fallback : fallback, code };
}

export function createAuthRoutes(service: AgentService): Hono {
  const app = new Hono();

  // GET /public-key — public; browser fetches this to encrypt the password.
  app.get("/public-key", (c) => c.json({ publicKey: keypair.publicKeyPem }));

  // GET /mode — public. Lets the web decide whether to skip login before it has
  // a token: in debug mode it returns the seeded debug user to enter directly.
  app.get("/mode", async (c) => {
    if (!service.debug || !service.debugUserId) {
      return c.json({ debug: false, user: null, managedRegistration: service.managedKeysEnabled });
    }
    const user = await service.db.getUserById(service.debugUserId);
    return c.json({ debug: true, user: user ? toPublicUser(user) : null, managedRegistration: service.managedKeysEnabled });
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
      const result = service.managedKeysEnabled
        ? await service.tokenhub.authenticateAgentUser(username, password)
        : await service.tokenhub.login(username, password);
      const user = "managedKey" in result
        ? await service.db.upsertManagedUser({
            externalUserId: result.userId,
            username: result.username,
            name: result.name,
            tokenId: result.managedKey.tokenId,
            apiKey: result.managedKey.apiKey,
            credentialVersion: result.managedKey.credentialVersion,
          })
        : await service.db.upsertUserByExternalId({
            externalUserId: result.userId,
            username: result.name,
            apiKeys: result.apiKeys,
          });
      const token = await service.sessions.createSession(user.id);
      return c.json({ token, user: toPublicUser(user) });
    } catch (err) {
      // Client sees one generic message; the cause is logged for operators.
      logger.warn("login failed", { route: "login", err });
      return c.json({ error: LOGIN_FAIL }, 401);
    }
  });

  app.post("/verification/email", async (c) => {
    if (!service.managedKeysEnabled) {
      return c.json({ error: "注册功能未启用" }, 404);
    }
    let body: { email?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.email?.trim()) {
      return c.json({ error: "请输入邮箱地址" }, 400);
    }
    try {
      const result = await service.tokenhub.sendAgentEmailVerification(body.email.trim());
      return c.json({ ok: true, ...result });
    } catch (err) {
      logger.warn("email verification send failed", { route: "verification/email", err });
      const mapped = contactError(err, "邮箱验证码发送失败，请稍后重试");
      return c.json({ error: mapped.message, code: mapped.code }, 400);
    }
  });

  app.post("/verification/phone", async (c) => {
    if (!service.managedKeysEnabled) {
      return c.json({ error: "验证码登录功能未启用" }, 404);
    }
    let body: { phone?: string; purpose?: "register" | "login" };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.phone?.trim() || (body.purpose !== "register" && body.purpose !== "login")) {
      return c.json({ error: "请输入手机号" }, 400);
    }
    try {
      const result = await service.tokenhub.sendAgentPhoneVerification(body.phone.trim(), body.purpose);
      return c.json({ ok: true, ...result });
    } catch (err) {
      logger.warn("phone verification send failed", { route: "verification/phone", err });
      const mapped = contactError(err, "手机验证码发送失败，请稍后重试");
      return c.json({ error: mapped.message, code: mapped.code }, 400);
    }
  });

  app.post("/phone-login", async (c) => {
    if (!service.managedKeysEnabled) {
      return c.json({ error: LOGIN_FAIL }, 404);
    }
    let body: { phone?: string; verificationCode?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.phone?.trim() || !body.verificationCode?.trim()) {
      return c.json({ error: "请输入手机号和验证码" }, 400);
    }
    try {
      const result = await service.tokenhub.authenticateAgentUserByPhone(
        body.phone.trim(),
        body.verificationCode.trim()
      );
      const user = await service.db.upsertManagedUser({
        externalUserId: result.userId,
        username: result.username,
        name: result.name,
        tokenId: result.managedKey.tokenId,
        apiKey: result.managedKey.apiKey,
        credentialVersion: result.managedKey.credentialVersion,
      });
      const token = await service.sessions.createSession(user.id);
      return c.json({ token, user: toPublicUser(user) });
    } catch (err) {
      logger.warn("phone login failed", { route: "phone-login", err });
      const mapped = contactError(err, "手机号或验证码错误");
      return c.json({ error: mapped.message, code: mapped.code }, 401);
    }
  });

  // POST /register — creates a real New API user and its admin-only managed
  // subscription key in one idempotent New API transaction.
  app.post("/register", async (c) => {
    if (!service.managedKeysEnabled) {
      return c.json({ error: "注册功能未启用" }, 404);
    }
    let body: {
      username?: string;
      encryptedPassword?: string;
      email?: string;
      emailVerificationCode?: string;
      phone?: string;
      phoneVerificationCode?: string;
      displayName?: string;
      requestId?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.username || !body.encryptedPassword) {
      return c.json({ error: LOGIN_FAIL }, 400);
    }
    try {
      const password = keypair.decrypt(body.encryptedPassword);
      const result = await service.tokenhub.registerAgentUser({
        requestId: body.requestId?.trim() || randomUUID(),
        username: body.username.trim(),
        password,
        email: body.email?.trim(),
        emailVerificationCode: body.emailVerificationCode?.trim(),
        phone: body.phone?.trim(),
        phoneVerificationCode: body.phoneVerificationCode?.trim(),
        displayName: body.displayName?.trim(),
      });
      const user = await service.db.upsertManagedUser({
        externalUserId: result.userId,
        username: result.username,
        name: result.name,
        tokenId: result.managedKey.tokenId,
        apiKey: result.managedKey.apiKey,
        credentialVersion: result.managedKey.credentialVersion,
      });
      const token = await service.sessions.createSession(user.id);
      return c.json({ token, user: toPublicUser(user) });
    } catch (err) {
      logger.warn("registration failed", { route: "register", err });
      const mapped = contactError(err, "注册失败，请稍后再试或者联系管理员");
      return c.json({ error: mapped.message, code: mapped.code }, 400);
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
      const loginResult = await service.tokenhub.tokenLogin(token);
      const result = service.managedKeysEnabled
        ? await service.tokenhub.ensureManagedKey(loginResult.userId)
        : loginResult;
      const user = "managedKey" in result
        ? await service.db.upsertManagedUser({
            externalUserId: result.userId,
            username: result.username,
            name: result.name,
            tokenId: result.managedKey.tokenId,
            apiKey: result.managedKey.apiKey,
            credentialVersion: result.managedKey.credentialVersion,
          })
        : await service.db.upsertUserByExternalId({
            externalUserId: result.userId,
            username: result.name,
            apiKeys: result.apiKeys,
          });
      const sessionToken = await service.sessions.createSession(user.id);
      return c.json({ token: sessionToken, user: toPublicUser(user) });
    } catch (err) {
      // Same opacity as /login — client sees one message; cause is logged.
      logger.warn("token-login failed", { route: "token-login", err });
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
    if (service.managedKeysEnabled) {
      try {
        await service.syncManagedCredential(s.userId);
      } catch (err) {
        logger.warn("managed credential sync failed", { route: "me", userId: s.userId, err });
        return c.json({ error: "Unauthorized" }, 401);
      }
    }
    const user = await service.db.getUserById(s.userId);
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json(toPublicUser(user));
  });

  return app;
}

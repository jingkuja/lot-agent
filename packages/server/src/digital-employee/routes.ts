import { Hono } from "hono";
import { apiError, InputError } from "./errors.js";
import type { DigitalEmployeeService } from "./service.js";
import {
  parseManualObservation,
  parseCreateProfile,
  parseProfileList,
  parseUpdateProductState,
  parseUpdateProfile,
  parseVersion,
  parseEntityId,
} from "./validators.js";

type Variables = { userId: string };

/** Browser-facing, authenticated customer-profile API. */
export function createDigitalEmployeeRoutes(service: DigitalEmployeeService): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.delete("/conversation-context/:conversationId", async (c) => {
    try {
      await service.clearCurrentProfile(
        c.get("userId"),
        parseEntityId(c.req.param("conversationId"), "conversationId")
      );
      return c.json({ ok: true });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/profiles", async (c) => {
    try {
      return c.json(await service.listProfiles(c.get("userId"), parseProfileList(c.req.query())));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/profiles", async (c) => {
    try {
      return c.json(await service.createProfile(c.get("userId"), parseCreateProfile(await body(c))), 201);
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/profiles/:id/timeline", async (c) => {
    try {
      const profileId = parseEntityId(c.req.param("id"), "profileId");
      const [observations, changes] = await Promise.all([
        service.listObservations(c.get("userId"), profileId, 1, 50),
        service.listStateChanges(c.get("userId"), profileId, 1, 50),
      ]);
      return c.json({ observations: observations.items, changes: changes.items });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/profiles/:id/observations", async (c) => {
    try {
      return c.json(
        await service.listObservations(
          c.get("userId"),
          parseEntityId(c.req.param("id"), "profileId"),
          pagination(c.req.query("page"), "page", 1, 100_000, 1),
          pagination(c.req.query("limit"), "limit", 1, 100, 30)
        )
      );
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/profiles/:id/observations", async (c) => {
    try {
      return c.json(
        await service.addManualObservation(c.get("userId"), parseEntityId(c.req.param("id"), "profileId"), parseManualObservation(await body(c))),
        201
      );
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/profiles/:id/changes", async (c) => {
    try {
      return c.json(
        await service.listStateChanges(
          c.get("userId"),
          parseEntityId(c.req.param("id"), "profileId"),
          pagination(c.req.query("page"), "page", 1, 100_000, 1),
          pagination(c.req.query("limit"), "limit", 1, 100, 30)
        )
      );
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.patch("/profiles/:id/products/:productKey", async (c) => {
    try {
      const productKey = c.req.param("productKey").trim();
      if (!productKey || productKey.length > 160) throw new InputError("productKey无效");
      return c.json(
        await service.updateProductState(
          c.get("userId"),
          parseEntityId(c.req.param("id"), "profileId"),
          productKey,
          parseUpdateProductState(await body(c))
        )
      );
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/profiles/:id", async (c) => {
    try {
      return c.json(await service.getProfile(c.get("userId"), parseEntityId(c.req.param("id"), "profileId")));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.patch("/profiles/:id", async (c) => {
    try {
      return c.json(
        await service.updateProfile(c.get("userId"), parseEntityId(c.req.param("id"), "profileId"), parseUpdateProfile(await body(c)))
      );
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.delete("/profiles/:id", async (c) => {
    try {
      const payload = await body(c);
      return c.json(await service.archiveProfile(c.get("userId"), parseEntityId(c.req.param("id"), "profileId"), parseVersion(payload.version)));
    } catch (error) {
      return respondError(c, error);
    }
  });

  return app;
}

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => {
    throw new InputError("请求体必须是JSON对象");
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("请求体必须是JSON对象");
  return value as Record<string, unknown>;
}

function pagination(value: string | undefined, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new InputError(`${label}无效`);
  return number;
}

function respondError(c: { json: (body: unknown, status?: number) => Response }, error: unknown): Response {
  const result = apiError(error);
  return c.json(result.body, result.status);
}

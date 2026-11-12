import { Hono } from "hono";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import type { ObjectStorage } from "@lot-agent/core";
import type { AgentService } from "../services/agent-service.js";
import { createGenerationRoutes } from "./conversations.js";

async function setup() {
  const original = { url: "/static/assets/original.png", mime: "image/png" };
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#efefef" } }).png().toBuffer();
  let metadata: Record<string, unknown> = {
    kind: "generation", mediaType: "image", scene: "white_background", status: "completed", assets: [original], composites: [{ url: "/old.png" }],
  };
  const db = {
    getGenerationMessage: vi.fn(async () => ({ metadata })),
    getGeneratedByStorageKey: vi.fn(async () => ({ user_id: "owner" })),
    createAsset: vi.fn(),
    updateGenerationMetadata: vi.fn(async (_id: string, _owner: unknown, update: (meta: Record<string, unknown>) => Record<string, unknown> | null) => {
      const next = update(metadata);
      if (!next) return false;
      metadata = next;
      return true;
    }),
  };
  const assets = { get: vi.fn(async () => bytes), put: vi.fn(async () => ({ url: "/static/assets/corrected.png" })) };
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "owner"); await next(); });
  app.route("/", createGenerationRoutes({ db } as unknown as AgentService, { assets: assets as unknown as ObjectStorage }));
  const post = (restore: boolean) => app.request("/chat/generations/message/white-background", {
    method: "POST", body: JSON.stringify({ index: 0, restore }),
  });
  return { db, assets, post, original, metadata: () => metadata };
}

it("corrects only on request, retains the original and restores it without writing another asset", async () => {
  const { db, assets, post, original, metadata } = await setup();
  expect((await post(false)).status).toBe(200);
  expect(db.getGenerationMessage).toHaveBeenCalledWith("message", "chat", "owner");
  expect(metadata()).toMatchObject({ whiteOriginals: [original], whiteChecks: [{ corrected: true }] });
  expect(metadata()).not.toHaveProperty("composites");
  expect((await post(true)).status).toBe(200);
  expect(metadata().assets).toEqual([original]);
  expect(assets.put).toHaveBeenCalledTimes(1);
  expect(db.createAsset).toHaveBeenCalledTimes(1);
});

it("rejects another user's original before reading its bytes", async () => {
  const { db, assets, post } = await setup();
  db.getGeneratedByStorageKey.mockResolvedValue({ user_id: "other" });
  expect((await post(false)).status).toBe(404);
  expect(assets.get).not.toHaveBeenCalled();
  expect(assets.put).not.toHaveBeenCalled();
});

it("does not overwrite a concurrently changed image", async () => {
  const { db, post, metadata, original } = await setup();
  db.updateGenerationMetadata.mockImplementationOnce(async (_id, _owner, update) => {
    expect(update({ ...metadata(), assets: [{ url: "/changed.png" }] })).toBeNull();
    return false;
  });
  expect((await post(false)).status).toBe(409);
  expect(metadata().assets).toEqual([original]);
});

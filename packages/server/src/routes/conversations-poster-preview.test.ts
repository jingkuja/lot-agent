import { Hono } from "hono";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import type { ObjectStorage } from "@lot-agent/core";
import { emptyPosterFields, type PosterPreviewScene } from "@lot-agent/core/poster";
import { initializePosterFonts } from "../generation/poster-render.js";
import type { AgentService } from "../services/agent-service.js";
import { createGenerationRoutes } from "./conversations.js";

initializePosterFonts();

async function setup() {
  const bytes = await sharp({ create: { width: 96, height: 128, channels: 3, background: "#efefef" } }).png().toBuffer();
  const poster = {
    version: 1, template: "top_panel", fields: { ...emptyPosterFields(), title: "台灯" }, background: { url: "/static/assets/background.png" },
  };
  const metadata = { kind: "generation", mediaType: "image", status: "completed", assets: [{ url: "/static/assets/poster.png", mime: "image/png" }], posters: [poster] };
  const db = {
    getGenerationMessage: vi.fn(async () => ({ metadata })),
    getGeneratedByStorageKey: vi.fn(async () => ({ user_id: "owner" })),
    createAsset: vi.fn(),
    updateGenerationMetadata: vi.fn(),
  };
  const assets = { exists: vi.fn(async () => true), get: vi.fn(async () => bytes), put: vi.fn() };
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "owner"); await next(); });
  app.route("/", createGenerationRoutes({ db } as unknown as AgentService, { assets: assets as unknown as ObjectStorage }));
  const preview = (format?: "layers") => app.request("/chat/generations/message/poster/preview", {
    method: "POST",
    body: JSON.stringify({
      index: 0, template: "top_panel", fields: { ...poster.fields, title: "现代台灯" }, style: { parts: { title: { color: "#791515", dy: 2 } } }, format,
    }),
  });
  return { db, assets, preview };
}

it("previews an unsaved edit without storing it or changing the message", async () => {
  const { db, assets, preview } = await setup();
  const res = await preview();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  const image = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  expect([image.width, image.height]).toEqual([96, 128]);
  expect(assets.put).not.toHaveBeenCalled();
  expect(db.createAsset).not.toHaveBeenCalled();
  expect(db.updateGenerationMetadata).not.toHaveBeenCalled();
});

it("returns separate background and text layers for dragging without persisting the draft", async () => {
  const { db, assets, preview } = await setup();
  const res = await preview("layers");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const scene = await res.json() as PosterPreviewScene;
  expect([scene.width, scene.height]).toEqual([96, 128]);
  expect(scene.background).toMatch(/^data:image\/jpeg;base64,/);
  expect(scene.layers.map((layer) => layer.kind)).toEqual(["scrim", "text"]);
  expect(scene.layers[1]).toMatchObject({ kind: "text", part: "title", src: expect.stringMatching(/^data:image\/png;base64,/) });
  expect(assets.put).not.toHaveBeenCalled();
  expect(db.updateGenerationMetadata).not.toHaveBeenCalled();
});

it("refuses to preview another user's background before reading it", async () => {
  const { db, assets, preview } = await setup();
  db.getGeneratedByStorageKey.mockResolvedValue({ user_id: "other" });
  expect((await preview("layers")).status).toBe(409);
  expect(assets.get).not.toHaveBeenCalled();
});

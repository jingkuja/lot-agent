import type { ObjectStorage } from "@lot-agent/core";
import { Hono } from "hono";
import JSZip from "jszip";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import type { AgentService } from "../services/agent-service.js";
import { createGenerationRoutes } from "./conversations.js";

it("joins owned uploads and generated images in selection order and exports a vertical composer result as details", async () => {
  const swatch = (background: string) => sharp({ create: { width: 500, height: 1000, channels: 3, background } }).png().toBuffer();
  const [red, blue] = await Promise.all([swatch("red"), swatch("blue")]);
  const output = new Map([["generated.png", blue]]);
  let metadata: Record<string, unknown> = {};
  const row = (id: string, size_bytes: number, user_id = "owner") => ({ id, user_id, mime: "image/png", size_bytes });
  const db = {
    getConversation: vi.fn(async () => ({ user_id: "owner", agent_id: "image" })),
    getUploadByStorageKey: vi.fn(async (key: string) => row(key, red.length, key === "mine.png" ? "owner" : "other")),
    getGeneratedByStorageKey: vi.fn(async (key: string) => output.has(key) ? row(key, output.get(key)!.length) : null),
    getGenerationMessage: vi.fn(async () => ({ metadata })),
    createAsset: vi.fn(async () => {}),
    addMessage: vi.fn(async (_id, _cid, role, _content, options) => {
      if (role === "assistant") metadata = options.metadata;
    }),
  };
  const getUpload = vi.fn(async () => red);
  const service = { db, uploadStorage: { get: getUpload, exists: async () => true } } as unknown as AgentService;
  const assets: ObjectStorage = {
    get: async (key) => output.get(key)!,
    exists: async (key) => output.has(key),
    put: async ({ key, body }) => { output.set(key, Buffer.from(body)); return { url: `/static/assets/${key}` }; },
    putStream: async () => { throw new Error("unexpected streaming write"); },
    delete: async (key) => { output.delete(key); },
    getUrl: (key) => `/static/assets/${key}`,
  };
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "owner"); await next(); });
  app.route("/conversations", createGenerationRoutes(service, { assets }));
  const compose = (upload: string) => app.request("/conversations/c1/compose", {
    method: "POST", body: JSON.stringify({ urls: [upload, "/static/assets/generated.png"], layout: "vertical" }),
  });
  expect((await compose("/static/uploads/other.png")).status).toBe(409);
  expect(getUpload).not.toHaveBeenCalled();
  expect((await compose("/static/uploads/mine.png")).status).toBe(200);
  expect(metadata.composedFrom).toMatchObject({ layout: "vertical", sliceBoundaries: [1000] });
  const res = await app.request("/conversations/c1/generations/composed/export", {
    method: "POST", body: JSON.stringify({ preset: "taobao", names: ["详情"] }),
  });
  expect(res.status).toBe(200);
  const zip = await JSZip.loadAsync(await res.arrayBuffer());
  expect(Object.keys(zip.files)).toEqual(["详情_01.jpg", "详情_02.jpg"]);
  const parts = await Promise.all(Object.values(zip.files).map(async (part) => sharp(await part.async("nodebuffer"))
    .raw().toBuffer({ resolveWithObject: true })));
  expect(parts.map(({ info }) => [info.width, info.height])).toEqual([[750, 1500], [750, 1500]]);
  expect(parts[0].data[750 * 700 * 3]).toBeGreaterThan(240);
  expect(parts[1].data[750 * 700 * 3 + 2]).toBeGreaterThan(240);
});

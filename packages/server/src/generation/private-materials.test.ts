import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretBox } from "../auth/secret-box.js";
import { staticFileHandler } from "../static-files.js";
import { createOutputAccessGuard, createUploadAccessGuard, resolveMaterialReference, signPrivateMaterial, signPrivateOutput,
  type PrivateMaterialAsset } from "./private-materials.js";

const key = "11".repeat(32);
const asset: PrivateMaterialAsset = { id: "asset-1", user_id: "owner", type: "upload", storage_key: "portrait.png", url: "/static/uploads/portrait.png", is_private: true };
const start = 1_000_000;
const options = { masterKey: key, now: () => start, publicBaseUrl: "" };

describe("private material references", () => {
  it("keeps canonical URLs unchanged and signs private uploads for ten minutes", () => {
    const signed = signPrivateMaterial(asset, options);
    expect(signed).toMatch(/^\/static\/uploads\/portrait\.png\?material_token=/);
    expect(asset.url).toBe("/static/uploads/portrait.png");
    expect(signPrivateMaterial({ ...asset, is_private: false }, options)).toBe(asset.url);
    expect(signPrivateMaterial({ ...asset, type: "image" }, options)).toBe(asset.url);
    expect(signPrivateMaterial(asset, { ...options, publicBaseUrl: "https://media.example/" })).toMatch(/^https:\/\/media\.example\/static\/uploads\//);
    const token = new URL(signed, "https://local.invalid").searchParams.get("material_token")!;
    const envelope = Buffer.from(token, "base64url").toString("utf8");
    expect(envelope).not.toContain(asset.user_id);
    expect(JSON.parse(new SecretBox(key).open(envelope))).toEqual({
      purpose: "marketing-material:v1", id: asset.id, owner: asset.user_id, key: asset.storage_key, expires: start + 10 * 60_000,
    });
  });

  it("fails closed if the signing key is absent or malformed", () => {
    expect(() => signPrivateMaterial(asset, { ...options, masterKey: "" })).toThrow("未配置");
    expect(() => signPrivateMaterial(asset, { ...options, masterKey: "bad" })).toThrow();
    expect(() => signPrivateMaterial(asset, { ...options, publicBaseUrl: "https://user:secret@media.example" })).toThrow();
  });

  it("resolves owned relative, absolute and expired signed references without changing their identity", async () => {
    const db = { getUploadByStorageKey: vi.fn(async () => asset) };
    const configured = { ...options, publicBaseUrl: "https://media.example/app/" };
    for (const url of [asset.url, "https://media.example/app/static/uploads/portrait.png", `${asset.url}?material_token=expired`]) {
      expect(await resolveMaterialReference(db, "owner", url, configured)).toMatch(/^https:\/\/media\.example\/app\/static\/uploads\/portrait\.png\?material_token=/);
    }
    expect(db.getUploadByStorageKey).toHaveBeenCalledTimes(3);
    expect(asset.url).toBe("/static/uploads/portrait.png");
  });

  it("checks ownership even for public local uploads and leaves external references to existing SSRF checks", async () => {
    const db = { getUploadByStorageKey: vi.fn(async () => ({ ...asset, is_private: false })) };
    await expect(resolveMaterialReference(db, "other", asset.url, options)).rejects.toThrow("素材不存在");
    expect(await resolveMaterialReference(db, "owner", asset.url, options)).toBe(asset.url);
    expect(await resolveMaterialReference(db, "owner", "https://media.example/static/uploads/portrait.png", { ...options, publicBaseUrl: "https://media.example" }))
      .toBe("https://media.example/static/uploads/portrait.png");
    db.getUploadByStorageKey.mockClear();
    for (const external of ["https://vendor.example/static/uploads/portrait.png", "data:image/png;base64,AAAA", "http://127.0.0.1/clip.mp4"]) {
      expect(await resolveMaterialReference(db, "owner", external, { ...options, publicBaseUrl: "https://media.example" })).toBe(external);
    }
    expect(db.getUploadByStorageKey).not.toHaveBeenCalled();
  });

  it("does not write temporary URLs into frozen task inputs or asset rows", async () => {
    const frozenAsset = Object.freeze({ ...asset });
    const input = Object.freeze({ input_reference: Object.freeze([asset.url]), reference_audio: Object.freeze([asset.url]), reference_video: Object.freeze([asset.url]), first_frame: asset.url, last_frame: asset.url });
    const before = JSON.stringify(input);
    const db = { getUploadByStorageKey: vi.fn(async () => frozenAsset) };
    for (const value of Object.values(input)) {
      for (const url of typeof value === "string" ? [value] : value) {
        expect(await resolveMaterialReference(db, "owner", url, options)).toContain("material_token=");
      }
    }
    expect(JSON.stringify(input)).toBe(before);
    expect(frozenAsset.url).toBe(asset.url);
  });

  it("rejects missing files, malformed local paths, credentials and encoded traversal", async () => {
    const db = { getUploadByStorageKey: vi.fn(async () => asset as PrivateMaterialAsset | null) };
    for (const url of ["/static/uploads/../secret", "/static/uploads/%2e%2e%2fsecret", "/static/uploads/a%5cb.png", "/static/uploads/a%00.png", "/static/uploads/%", "/static/uploads/portrait.png#fragment", "https://user:secret@media.example/static/uploads/portrait.png"]) {
      await expect(resolveMaterialReference(db, "owner", url, { ...options, publicBaseUrl: "https://media.example" })).rejects.toThrow();
    }
    db.getUploadByStorageKey.mockResolvedValue(null);
    await expect(resolveMaterialReference(db, "owner", asset.url, options)).rejects.toThrow("素材不存在");
  });
});

describe("private upload HTTP boundary", () => {
  let directory: string;
  let now: number;
  let rows: Map<string, PrivateMaterialAsset>;
  let db: { getUploadByStorageKey: ReturnType<typeof vi.fn<(filename: string) => Promise<PrivateMaterialAsset | undefined>>> };
  let sessions: { resolve: ReturnType<typeof vi.fn<(token: string) => Promise<{ userId: string } | null>>> };
  let app: Hono;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "private-material-"));
    await writeFile(join(directory, asset.storage_key), "0123456789");
    await writeFile(join(directory, "public.png"), "public");
    await writeFile(join(directory, "orphan.png"), "orphan");
    now = start;
    rows = new Map([[asset.storage_key, { ...asset }], ["public.png", { ...asset, id: "public", storage_key: "public.png", is_private: false }]]);
    db = { getUploadByStorageKey: vi.fn(async filename => rows.get(filename)) };
    sessions = { resolve: vi.fn(async token => token === "owner-session" ? { userId: "owner" } : token === "other-session" ? { userId: "other" } : null) };
    const guard = createUploadAccessGuard(db, sessions, { ...options, now: () => now });
    app = new Hono();
    app.get("/static/uploads/:filename", staticFileHandler(directory, { authorize: guard }));
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("denies anonymous, invalid-session and cross-user access; accepts the owner", async () => {
    const requests: Record<string, string>[] = [{}, { Authorization: "Bearer invalid" }, { Authorization: "Bearer other-session" }];
    for (const headers of requests) {
      const response = await app.request(asset.url, { headers });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("not found");
    }
    const response = await app.request(asset.url, { headers: { Authorization: "Bearer owner-session" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789");
  });

  it("serves Range requests for an owner or a valid capability", async () => {
    const signed = signPrivateMaterial(asset, options);
    for (const [url, headers] of [[asset.url, { Authorization: "Bearer owner-session", Range: "bytes=2-5" }], [signed, { Range: "bytes=2-5" }]] as const) {
      const response = await app.request(url, { headers });
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).toBe("2345");
    }
  });

  it("rejects expired, tampered, unsigned, wrong-purpose and wrong-key capabilities", async () => {
    const signed = signPrivateMaterial(asset, options);
    now += 10 * 60_000;
    expect((await app.request(signed)).status).toBe(404);
    now = start;
    const token = new URL(signed, "https://local.invalid").searchParams.get("material_token")!;
    const middle = Math.floor(token.length / 2);
    const tampered = token.slice(0, middle) + (token[middle] === "A" ? "B" : "A") + token.slice(middle + 1);
    const claim = { purpose: "marketing-analysis-audio", id: asset.id, owner: asset.user_id, key: asset.storage_key, expires: now + 60_000 };
    for (const invalid of [tampered, Buffer.from(JSON.stringify(claim)).toString("base64url"), Buffer.from(new SecretBox(key).seal(JSON.stringify(claim))).toString("base64url")]) {
      expect((await app.request(`${asset.url}?material_token=${invalid}`)).status).toBe(404);
    }
    expect((await app.request(signPrivateMaterial(asset, { ...options, masterKey: "22".repeat(32) }))).status).toBe(404);
  });

  it("binds a capability to the current row ID, owner and storage key, and revokes it on deletion", async () => {
    const signed = signPrivateMaterial(asset, options);
    for (const changed of [{ id: "new-id" }, { user_id: "new-owner" }, { storage_key: "other.png" }]) {
      rows.set(asset.storage_key, { ...asset, ...changed });
      expect((await app.request(signed)).status).toBe(404);
    }
    rows.delete(asset.storage_key);
    expect((await app.request(signed)).status).toBe(404);
  });

  it("keeps public uploads available and rejects orphaned files and lookup failures", async () => {
    expect((await app.request("/static/uploads/public.png")).status).toBe(200);
    expect((await app.request("/static/uploads/orphan.png")).status).toBe(404);
    db.getUploadByStorageKey.mockRejectedValue(new Error("database unavailable"));
    expect((await app.request("/static/uploads/public.png")).status).toBe(404);
  });
});

describe("private generated outputs", () => {
  let directory: string;
  let now: number;
  type Output = { user_id: string; storage_key: string; is_private: boolean };
  let rows: Map<string, Output>;
  let db: { getGeneratedByStorageKey: ReturnType<typeof vi.fn<(key: string) => Promise<Output | undefined>>> };
  let app: Hono;
  const video = "/static/assets/film.mp4";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "private-output-"));
    await writeFile(join(directory, "film.mp4"), "0123456789");
    await writeFile(join(directory, "chat.png"), "public");
    now = start;
    rows = new Map([["film.mp4", { user_id: "owner", storage_key: "film.mp4", is_private: true }], ["chat.png", { user_id: "owner", storage_key: "chat.png", is_private: false }]]);
    db = { getGeneratedByStorageKey: vi.fn(async key => rows.get(key)) };
    const sessions = { resolve: vi.fn(async (token: string) => token === "owner-session" ? { userId: "owner" } : token === "other-session" ? { userId: "other" } : null) };
    app = new Hono();
    app.get("/static/assets/:filename", staticFileHandler(directory, { authorize: createOutputAccessGuard(db, sessions, { ...options, now: () => now }) }));
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("signs only local generated files, for six hours, and keeps other URLs", () => {
    const signed = signPrivateOutput("owner", video, options);
    expect(signed).toMatch(/^\/static\/assets\/film\.mp4\?material_token=/);
    const token = new URL(signed, "https://local.invalid").searchParams.get("material_token")!;
    expect(JSON.parse(new SecretBox(key).open(Buffer.from(token, "base64url").toString("utf8"))))
      .toEqual({ purpose: "private-output:v1", owner: "owner", key: "film.mp4", expires: start + 6 * 60 * 60_000 });
    for (const other of ["https://cdn.example/film.mp4", "/static/uploads/p.png", "/static/assets/../secret"]) expect(signPrivateOutput("owner", other, options)).toBe(other);
    const absolute = signPrivateOutput("owner", "https://media.example/app/static/assets/film.mp4", { ...options, publicBaseUrl: "https://media.example/app/" });
    expect(absolute).toMatch(/^https:\/\/media\.example\/app\/static\/assets\/film\.mp4\?material_token=/);
    expect(signPrivateOutput("owner", "https://other.example/static/assets/film.mp4", { ...options, publicBaseUrl: "https://media.example" }))
      .toBe("https://other.example/static/assets/film.mp4");
    // Without a signing key the stored link is kept; the file then needs the owner's session.
    expect(signPrivateOutput("owner", video, { ...options, masterKey: "" })).toBe(video);
  });

  it("serves a private video, with Range, only to its owner or a valid link; anonymous and other users get 404", async () => {
    const signed = signPrivateOutput("owner", video, options);
    for (const headers of [{}, { Authorization: "Bearer other-session" }, { Authorization: "Bearer invalid" }] as Record<string, string>[]) {
      expect((await app.request(video, { headers: { ...headers, Range: "bytes=0-3" } })).status).toBe(404);
    }
    for (const [url, headers] of [[video, { Authorization: "Bearer owner-session", Range: "bytes=2-5" }], [signed, { Range: "bytes=2-5" }]] as const) {
      const response = await app.request(url, { headers });
      expect(response.status).toBe(206);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).toBe("2345");
    }
    // Expired, another owner's, another file's or an upload link.
    now += 6 * 60 * 60_000;
    expect((await app.request(signed)).status).toBe(404);
    now = start;
    expect((await app.request(signPrivateOutput("other", video, options))).status).toBe(404);
    rows.set("other.mp4", { user_id: "owner", storage_key: "other.mp4", is_private: true });
    await writeFile(join(directory, "other.mp4"), "x");
    expect((await app.request(`/static/assets/other.mp4?${signed.split("?")[1]}`)).status).toBe(404);
    const upload = signPrivateMaterial({ id: "a", user_id: "owner", type: "upload", storage_key: "film.mp4", url: "/static/uploads/film.mp4", is_private: true }, options);
    expect((await app.request(`${video}?${upload.split("?")[1]}`)).status).toBe(404);
  });

  it("keeps other generated files public and cacheable, and fails closed when the lookup fails", async () => {
    const response = await app.request("/static/assets/chat.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
    db.getGeneratedByStorageKey.mockRejectedValue(new Error("database unavailable"));
    expect((await app.request("/static/assets/chat.png")).status).toBe(404);
  });
});

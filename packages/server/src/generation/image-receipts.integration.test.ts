import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { loadRepoEnv } from "../env-file.js";
import { imageCallReceipts } from "../db/migrations/0082-image-call-receipts.js";
import { DurableImageProvider, PgImageCallStore } from "./image-receipts.js";

describe.skipIf(process.env.IMAGE_PG_TEST !== "1")("image receipts on local PostgreSQL", () => {
  const schema = `image_receipts_test_${randomUUID().replaceAll("-", "")}`;
  let pool: pg.Pool;
  let root: string;
  let created = false;
  beforeAll(async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, VITEST: undefined };
    loadRepoEnv({ env });
    const host = env.PG_HOST ?? "localhost";
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("Local PostgreSQL required");
    pool = new pg.Pool({ host, port: Number(env.PG_PORT) || 5432, user: env.PG_USER ?? "postgres", password: env.PG_PASSWORD,
      database: env.PG_DATABASE ?? "lot", options: `-c search_path=${schema}`, connectionTimeoutMillis: 3000 });
    await pool.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await pool.query("CREATE TABLE tasks(id UUID PRIMARY KEY,user_id TEXT,status TEXT)");
    await imageCallReceipts.up(pool);
    root = await mkdtemp(join(tmpdir(), "image-receipts-test-"));
  });
  afterAll(async () => {
    if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("atomically claims, persists Base64 privately, and recovers with a new instance", async () => {
    const id = randomUUID();
    await pool.query("INSERT INTO tasks VALUES($1,'owner','running')", [id]);
    const stores = Array.from({ length: 8 }, () => new PgImageCallStore(pool, root, "owner", id));
    const claims = await Promise.all(stores.map(store => store.claim(0, "scope")));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner = stores[claims.indexOf(true)];
    await owner.save(0, { state: "completed", fingerprint: "scope", result: {
      status: "completed", progress: 100, urls: ["data:image/png;base64,aGVsbG8=", "https://images.example/second.png"],
    } });
    const recovered = new PgImageCallStore(pool, root, "owner", id);
    const receipt = await recovered.get(0);
    const url = receipt!.result!.urls![0];
    expect(url).toMatch(/^image-receipt:/);
    expect((await recovered.read(url)).body.toString()).toBe("hello");
    const intruder = new PgImageCallStore(pool, root, "other", id);
    expect(await intruder.get(0)).toBeNull();
    expect(await intruder.claim(1, "scope")).toBe(false);
    await expect(intruder.read(url)).rejects.toThrow("not found");
    const provider = { create: vi.fn(), poll: vi.fn() };
    const durable = new DurableImageProvider(provider, recovered, "scope");
    const made = await durable.create({ prompt: "recover" });
    expect((await durable.poll(made.taskId)).urls).toEqual(receipt!.result!.urls);
    expect(provider.create).not.toHaveBeenCalled();
    await owner.save(0, { state: "unknown", fingerprint: "scope" });
    expect((await recovered.get(0))?.state).toBe("completed");
    await recovered.save(0, { state: "completed", fingerprint: "scope", result: {
      status: "completed", progress: 100, urls: ["data:image/png;base64,bGF0ZQ=="],
    } });
    expect((await recovered.read(url)).body.toString()).toBe("hello");
    expect((await recovered.get(0))?.result?.urls).toEqual(receipt!.result!.urls);
  });

  it("does not POST after a process dies with only its submission intent persisted", async () => {
    const id = randomUUID();
    await pool.query("INSERT INTO tasks VALUES($1,'owner','running')", [id]);
    await new PgImageCallStore(pool, root, "owner", id).claim(0, "scope");
    const provider = { create: vi.fn(), poll: vi.fn() };
    const durable = new DurableImageProvider(provider, new PgImageCallStore(pool, root, "owner", id), "scope");
    await expect(durable.create({ prompt: "recover" })).rejects.toMatchObject({ errorCode: "IMAGE_RESULT_UNKNOWN", name: "UnrecoverableError" });
    expect(provider.create).not.toHaveBeenCalled();
  });
});

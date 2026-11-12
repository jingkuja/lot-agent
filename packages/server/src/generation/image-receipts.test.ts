import { describe, expect, it, vi } from "vitest";
import type { ImageCallReceipt, ImageCallStore } from "@lot-agent/core";
import { DurableImageProvider, ImageResultUnknown } from "./image-receipts.js";

function memory() {
  const rows = new Map<number, ImageCallReceipt>();
  const store: ImageCallStore = {
    async claim(slot, fingerprint) {
      if (rows.has(slot)) return false;
      rows.set(slot, { state: "submitting", fingerprint });
      return true;
    },
    async get(slot) { return rows.get(slot) ?? null; },
    async save(slot, receipt) { rows.set(slot, receipt); },
  };
  return { store, rows };
}
const result = { status: "completed", progress: 100, urls: ["https://images.example/a.png", "data:image/png;base64,Yg=="] };
const request = { prompt: "product", n: 2 };

describe("durable image calls", () => {
  it("recovers all synchronous outputs with a new provider without another POST", async () => {
    const { store } = memory();
    const provider = { create: vi.fn(async () => ({ taskId: "images_old", status: "completed", progress: 100, result })), poll: vi.fn() };
    const first = await new DurableImageProvider(provider, store, "scope").create(request);
    const recovered = new DurableImageProvider(provider, store, "scope");
    expect(await recovered.create(request)).toMatchObject({ taskId: first.taskId });
    expect(await recovered.poll(first.taskId)).toEqual(result);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.poll).not.toHaveBeenCalled();
  });

  it("does not submit again after loss of the response or failure to persist it", async () => {
    for (const afterResponse of [false, true]) {
      const { store } = memory();
      const provider = { create: vi.fn(async () => {
        if (!afterResponse) throw new Error("socket reset with private data");
        return { taskId: "images_old", status: "completed", progress: 100, result };
      }), poll: vi.fn() };
      if (afterResponse) store.save = async () => { throw new Error("db down"); };
      await expect(new DurableImageProvider(provider, store, "scope").create(request)).rejects.toThrow();
      await expect(new DurableImageProvider(provider, store, "scope").create(request)).rejects.toBeInstanceOf(ImageResultUnknown);
      expect(provider.create).toHaveBeenCalledTimes(1);
    }
  });

  it("allows only one concurrent claimant and never crosses credential scopes", async () => {
    const { store } = memory();
    let finish!: (value: { taskId: string; status: string; progress: number; result: typeof result }) => void;
    const provider = { create: vi.fn(() => new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve; })), poll: vi.fn() };
    const one = new DurableImageProvider(provider, store, "scope").create(request);
    await expect(new DurableImageProvider(provider, store, "scope").create(request)).rejects.toBeInstanceOf(ImageResultUnknown);
    finish({ taskId: "images_old", status: "completed", progress: 100, result });
    await one;
    await expect(new DurableImageProvider(provider, store, "other-user-key").create(request)).rejects.toBeInstanceOf(ImageResultUnknown);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it("resumes async IDs, rejects legacy fake IDs, and honors cancellation before claim", async () => {
    const { store, rows } = memory();
    rows.set(2, { state: "submitted", vendorId: "real-task", fingerprint: "scope" });
    const provider = { create: vi.fn(), poll: vi.fn(async () => result) };
    const durable = new DurableImageProvider(provider, store, "scope");
    expect(await durable.poll("receipt:2")).toEqual(result);
    expect(provider.poll).toHaveBeenCalledWith("real-task");
    await expect(durable.poll("images_no-receipt")).rejects.toBeInstanceOf(ImageResultUnknown);
    await expect(durable.create(request, { signal: AbortSignal.abort(), slot: 3 })).rejects.toThrow();
    expect(rows.has(3)).toBe(false);
    expect(provider.create).not.toHaveBeenCalled();
  });
});

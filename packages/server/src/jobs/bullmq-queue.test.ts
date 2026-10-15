import { beforeEach, describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import type { DB } from "../db/database.js";
const mocks = vi.hoisted(() => ({ queues: new Map<string, any>(), workers: new Map<string, any>() }));
vi.mock("bullmq", () => ({
  Queue: class {
    add = vi.fn(); getJob = vi.fn(); close = vi.fn();
    constructor(name: string) { mocks.queues.set(name, this); }
  },
  Worker: class {
    close = vi.fn();
    constructor(name: string, public run: (job: any) => Promise<unknown>, public options: any) { mocks.workers.set(name, this); }
  },
}));
import { BullmqJobQueue } from "./bullmq-queue.js";
import { DEFAULT_TASK_QUEUE, MARKETING_VIDEO_QUEUE } from "./task-queues.js";

function fixture() {
  const db = {
    createTask: vi.fn(), cancelTask: vi.fn(async () => true), markTaskRunning: vi.fn(async () => true),
    getTask: vi.fn(async (id: string) => ({ id, type: id === "ordinary" ? "image.generate" : "marketing.video", status: "pending", input: { original: true }, user_id: "owner", created_at: "now", updated_at: "now" })),
    setTaskResult: vi.fn(), setTaskError: vi.fn(),
  };
  const connection = { disconnect: vi.fn() };
  const queue = new BullmqJobQueue(db as unknown as DB, connection as unknown as Redis);
  return { queue, db, connection, ordinary: mocks.queues.get(DEFAULT_TASK_QUEUE), marketing: mocks.queues.get(MARKETING_VIDEO_QUEUE) };
}
function stored(state: string) { return { getState: vi.fn(async () => state), retry: vi.fn(), remove: vi.fn() }; }
function job(id = "same-id", name = "marketing.video") { return { data: { taskId: id }, name, attemptsMade: 0, updateProgress: vi.fn() }; }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { mocks.queues.clear(); mocks.workers.clear(); });

describe("isolated marketing task delivery", () => {
  it("keeps the DB task ID and disables automatic paid retries on its own queue", async () => {
    const f = fixture();
    await f.queue.deliverPersisted("task-id", "marketing.video");
    expect(f.marketing.add).toHaveBeenCalledWith("marketing.video", { taskId: "task-id" }, expect.objectContaining({ jobId: "task-id", attempts: 1 }));
    expect(f.ordinary.add).not.toHaveBeenCalled();
  });
  it.each(["marketing.video", "image.generate"])("persists the routing metadata before enqueueing %s", async type => {
    const f = fixture();
    const id = await f.queue.enqueue(type, { original: true }, "owner");
    const name = type === "marketing.video" ? MARKETING_VIDEO_QUEUE : DEFAULT_TASK_QUEUE;
    expect(f.db.createTask).toHaveBeenCalledWith(id, type, { original: true }, "owner", name);
    expect(mocks.queues.get(name).add).toHaveBeenCalledWith(type, { taskId: id }, expect.objectContaining({ jobId: id }));
  });
  it.each(["failed", "completed"] as const)("can explicitly resume a %s entry on the dedicated queue", async state => {
    const f = fixture(), previous = stored(state); f.marketing.getJob.mockResolvedValue(previous);
    expect(await f.queue.canResumePersisted("same-id")).toBe(true);
    await f.queue.deliverPersisted("same-id", "marketing.video");
    expect(previous.retry).toHaveBeenCalledWith(state); expect(f.marketing.add).not.toHaveBeenCalled();
  });
  it.each(["active", "waiting", "delayed"])("does not replace a %s dedicated entry", async state => {
    const f = fixture(), previous = stored(state); f.marketing.getJob.mockResolvedValue(previous);
    expect(await f.queue.canResumePersisted("same-id")).toBe(false);
    await f.queue.deliverPersisted("same-id", "marketing.video");
    expect(previous.retry).not.toHaveBeenCalled(); expect(f.marketing.add).not.toHaveBeenCalled();
  });
  it.each(["waiting", "delayed", "prioritized", "failed", "completed"])("moves a legacy %s entry with its original ID", async state => {
    const f = fixture(), previous = stored(state); f.ordinary.getJob.mockResolvedValue(previous);
    await f.queue.deliverPersisted("same-id", "marketing.video");
    expect(previous.remove).toHaveBeenCalledOnce(); expect(previous.retry).not.toHaveBeenCalled();
    expect(f.marketing.add).toHaveBeenCalledWith("marketing.video", { taskId: "same-id" }, expect.objectContaining({ jobId: "same-id", attempts: 1 }));
  });
  it("does not duplicate an active legacy worker", async () => {
    const f = fixture(), previous = stored("active"); f.ordinary.getJob.mockResolvedValue(previous);
    expect(await f.queue.canResumePersisted("same-id")).toBe(false);
    await f.queue.deliverPersisted("same-id", "marketing.video");
    expect(previous.remove).not.toHaveBeenCalled(); expect(f.marketing.add).not.toHaveBeenCalled();
  });
  it("does not publish when the legacy entry becomes locked during migration", async () => {
    const f = fixture(), previous = stored("waiting"); f.ordinary.getJob.mockResolvedValue(previous);
    previous.remove.mockRejectedValue(new Error("locked"));
    await expect(f.queue.deliverPersisted("same-id", "marketing.video")).rejects.toThrow("locked");
    expect(f.marketing.add).not.toHaveBeenCalled();
  });
});

describe("isolated task workers", () => {
  it("finishes an ordinary task while the marketing handler is still waiting", async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    f.queue.process("marketing.video", async () => { entered.resolve(); await release.promise; return "marketing-done"; });
    f.queue.process("image.generate", async () => "ordinary-done");
    const marketing = mocks.workers.get(MARKETING_VIDEO_QUEUE), ordinary = mocks.workers.get(DEFAULT_TASK_QUEUE);
    expect(mocks.workers.size).toBe(2);
    expect(marketing.options.concurrency).toBe(1); expect(ordinary.options.concurrency).toBe(1);
    const running = marketing.run(job()); await entered.promise;
    try {
      await expect(ordinary.run(job("ordinary", "image.generate"))).resolves.toBe("ordinary-done");
      expect(f.db.setTaskResult).toHaveBeenCalledWith("ordinary", "ordinary-done");
      expect(f.db.setTaskResult).not.toHaveBeenCalledWith("same-id", expect.anything());
    } finally { release.resolve(); await running; }
  });
  it("forwards a legacy task without claiming, executing, or completing the business task", async () => {
    const f = fixture(), handler = vi.fn(); f.queue.process("marketing.video", handler);
    await mocks.workers.get(DEFAULT_TASK_QUEUE).run(job());
    expect(f.marketing.add).toHaveBeenCalledWith("marketing.video", { taskId: "same-id" }, expect.objectContaining({ jobId: "same-id", attempts: 1 }));
    expect(handler).not.toHaveBeenCalled(); expect(f.db.markTaskRunning).not.toHaveBeenCalled(); expect(f.db.setTaskResult).not.toHaveBeenCalled();
  });
  it.each(["failed", "cancelled", "succeeded"])("does not forward a legacy task in terminal DB state %s", async status => {
    const f = fixture(); f.queue.process("marketing.video", vi.fn());
    f.db.getTask.mockResolvedValue({ type: "marketing.video", status } as any);
    await mocks.workers.get(DEFAULT_TASK_QUEUE).run(job());
    expect(f.marketing.add).not.toHaveBeenCalled(); expect(f.db.markTaskRunning).not.toHaveBeenCalled();
  });
  it("preserves the DB claim guard before running the dedicated handler", async () => {
    const f = fixture(), handler = vi.fn(); f.queue.process("marketing.video", handler);
    f.db.markTaskRunning.mockResolvedValue(false);
    await mocks.workers.get(MARKETING_VIDEO_QUEUE).run(job());
    expect(handler).not.toHaveBeenCalled(); expect(f.db.setTaskResult).not.toHaveBeenCalled();
  });
  it("aborts a marketing handler and removes queued entries from both queues", async () => {
    const f = fixture(), entered = deferred();
    let signal!: AbortSignal;
    f.queue.process("marketing.video", async (_job, ctl) => {
      signal = ctl.signal; entered.resolve();
      await new Promise<void>(done => ctl.signal.addEventListener("abort", () => done(), { once: true }));
      return "cancelled";
    });
    const running = mocks.workers.get(MARKETING_VIDEO_QUEUE).run(job()); await entered.promise;
    const legacy = stored("waiting"), current = stored("delayed");
    f.ordinary.getJob.mockResolvedValue(legacy); f.marketing.getJob.mockResolvedValue(current);
    expect(await f.queue.cancel("same-id")).toBe(true);
    await running;
    expect(signal.aborted).toBe(true); expect(f.db.cancelTask).toHaveBeenCalledWith("same-id");
    expect(legacy.remove).toHaveBeenCalledOnce(); expect(current.remove).toHaveBeenCalledOnce();
  });
  it("closes both workers and queues before disconnecting", async () => {
    const f = fixture(); f.queue.process("marketing.video", vi.fn());
    const workers = [...mocks.workers.values()];
    await f.queue.close();
    for (const worker of workers) expect(worker.close).toHaveBeenCalledOnce();
    expect(f.ordinary.close).toHaveBeenCalledOnce(); expect(f.marketing.close).toHaveBeenCalledOnce(); expect(f.connection.disconnect).toHaveBeenCalledOnce();
  });
});

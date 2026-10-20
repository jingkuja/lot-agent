import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import type { DB } from "../db/database.js";
const mocks = vi.hoisted(() => ({ queues: new Map<string, any>(), workers: new Map<string, any>() }));
vi.mock("bullmq", () => ({
  DelayedError: class DelayedError extends Error {},
  Queue: class {
    add = vi.fn(); getJob = vi.fn(async () => undefined); getActive = vi.fn(async () => [] as any[]); close = vi.fn();
    constructor(name: string) { mocks.queues.set(name, this); }
  },
  Worker: class {
    close = vi.fn();
    constructor(name: string, public run: (job: any) => Promise<unknown>, public options: any) { mocks.workers.set(name, this); }
  },
}));
import { BullmqJobQueue } from "./bullmq-queue.js";
import { DEFAULT_TASK_QUEUE, MARKETING_VIDEO_QUEUE, marketingQueueLimits } from "./task-queues.js";

function fixture(limits = { concurrency: 2, perUser: 1, segments: 2 }) {
  const db = {
    createTask: vi.fn(), cancelTask: vi.fn(async () => true), markTaskRunning: vi.fn(async () => true),
    claimTaskWithinOwnerLimit: vi.fn(async () => "claimed" as "claimed" | "busy" | "stopped"),
    getTask: vi.fn(async (id: string) => ({ id, type: id === "ordinary" ? "image.generate" : "marketing.video", status: "pending", input: { original: true }, user_id: "owner", created_at: "now", updated_at: "now" })),
    getTaskStatus: vi.fn(async () => "running"),
    setTaskResult: vi.fn(), setTaskError: vi.fn(), markTaskRetryPending: vi.fn(),
    findStalePendingTasks: vi.fn(async () => [{ id: "old-task" }]), setPendingTaskDiagnostic: vi.fn(),
  };
  const connection = { status: "ready", disconnect: vi.fn() };
  const queue = new BullmqJobQueue(db as unknown as DB, connection as unknown as Redis, limits);
  return { queue, db, connection, ordinary: mocks.queues.get(DEFAULT_TASK_QUEUE), marketing: mocks.queues.get(MARKETING_VIDEO_QUEUE) };
}
function stored(state: string) { return { getState: vi.fn(async () => state), retry: vi.fn(), remove: vi.fn() }; }
function job(id = "same-id", name = "marketing.video") { return { id, data: { taskId: id }, name, attemptsMade: 0, timestamp: Date.now(), opts: { attempts: 1 }, updateProgress: vi.fn(), moveToDelayed: vi.fn() }; }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { mocks.queues.clear(); mocks.workers.clear(); });
afterEach(() => vi.useRealTimers());

describe("pending diagnostics", () => {
  it.each(["waiting", "delayed", "prioritized", "active"])("keeps a healthy %s entry live in either queue", async state => {
    const f = fixture(); f.ordinary.getJob.mockResolvedValue(stored(state));
    await f.queue.diagnosePending(180_000);
    expect(f.db.setPendingTaskDiagnostic).toHaveBeenCalledWith("old-task", "等待队列处理");
    expect(f.db.setTaskError).not.toHaveBeenCalled();
    expect(f.marketing.add).not.toHaveBeenCalled();
  });
  it("distinguishes unreadable Redis from confirmed missing delivery", async () => {
    const f = fixture(); f.marketing.getJob.mockRejectedValue(new Error("Redis unavailable"));
    await f.queue.diagnosePending(180_000);
    expect(f.db.setPendingTaskDiagnostic).toHaveBeenLastCalledWith("old-task", "队列状态待核实");
    f.marketing.getJob.mockResolvedValue(undefined);
    await f.queue.diagnosePending(180_000);
    expect(f.db.setPendingTaskDiagnostic).toHaveBeenLastCalledWith("old-task", "投递未完成，可恢复排队");
    expect(f.db.setTaskError).not.toHaveBeenCalled();
  });
  it("bounds a hung Redis read without assuming delivery is missing", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.ordinary.getJob.mockReturnValue(new Promise(() => {}));
    const diagnostic = f.queue.diagnosePending(180_000);
    await vi.advanceTimersByTimeAsync(2000); await diagnostic;
    expect(f.db.setPendingTaskDiagnostic).toHaveBeenCalledWith("old-task", "队列状态待核实");
    expect(f.marketing.add).not.toHaveBeenCalled();
  });
  it("does not enqueue diagnostic reads while Redis is disconnected", async () => {
    const f = fixture(); f.connection.status = "reconnecting";
    await f.queue.diagnosePending(180_000);
    expect(f.ordinary.getJob).not.toHaveBeenCalled();
    expect(f.db.setPendingTaskDiagnostic).toHaveBeenCalledWith("old-task", "队列状态待核实");
  });
  it("acknowledges durable cancellation during a Redis outage and prevents recovery", async () => {
    const f = fixture(); f.connection.status = "reconnecting";
    expect(await f.queue.cancel("same-id")).toBe(true);
    expect(f.db.cancelTask).toHaveBeenCalledWith("same-id");
    expect(f.ordinary.getJob).not.toHaveBeenCalled();
    expect(await f.queue.canResumePersisted("same-id")).toBe(false);
  });
});

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
  it("keeps a permitted ordinary retry pending and only makes the final attempt failed", async () => {
    const f = fixture(); f.queue.process("image.generate", async () => { throw new Error("temporary"); });
    const task = { ...job("ordinary", "image.generate"), opts: { attempts: 2 } };
    const worker = mocks.workers.get(DEFAULT_TASK_QUEUE);
    await expect(worker.run(task)).rejects.toThrow("temporary");
    expect(f.db.markTaskRetryPending).toHaveBeenCalledWith("ordinary", 1);
    expect(f.db.setTaskError).not.toHaveBeenCalled();
    await expect(worker.run({ ...task, attemptsMade: 1 })).rejects.toThrow("temporary");
    expect(f.db.setTaskError).toHaveBeenCalledWith("ordinary", "temporary");
  });
  it("observes a cancellation that races the DB claim before entering the handler", async () => {
    const f = fixture(), handler = vi.fn(); f.queue.process("marketing.video", handler);
    f.db.getTaskStatus.mockResolvedValue("cancelled");
    await mocks.workers.get(MARKETING_VIDEO_QUEUE).run(job());
    expect(handler).not.toHaveBeenCalled();
  });
  it("aborts on cancellation written by another process", async () => {
    vi.useFakeTimers();
    const f = fixture(), entered = deferred();
    let signal!: AbortSignal;
    f.queue.process("marketing.video", async (_job, ctl) => {
      signal = ctl.signal; entered.resolve();
      await new Promise<void>(done => ctl.signal.addEventListener("abort", () => done(), { once: true }));
    });
    const running = mocks.workers.get(MARKETING_VIDEO_QUEUE).run(job()); await entered.promise;
    f.db.getTaskStatus.mockResolvedValue("cancelled");
    await vi.advanceTimersByTimeAsync(1000); await running;
    expect(signal.aborted).toBe(true);
  });
  it("finishes an ordinary task while the marketing handler is still waiting", async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    f.queue.process("marketing.video", async () => { entered.resolve(); await release.promise; return "marketing-done"; });
    f.queue.process("image.generate", async () => "ordinary-done");
    const marketing = mocks.workers.get(MARKETING_VIDEO_QUEUE), ordinary = mocks.workers.get(DEFAULT_TASK_QUEUE);
    expect(mocks.workers.size).toBe(2);
    expect(marketing.options.concurrency).toBe(2); expect(ordinary.options.concurrency).toBe(1);
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
    f.db.claimTaskWithinOwnerLimit.mockResolvedValue("stopped");
    await mocks.workers.get(MARKETING_VIDEO_QUEUE).run(job());
    expect(handler).not.toHaveBeenCalled(); expect(f.db.setTaskResult).not.toHaveBeenCalled();
  });
  it("delays a render while the same owner already holds the per-user slot", async () => {
    const f = fixture(), handler = vi.fn(); f.queue.process("marketing.video", handler);
    f.marketing.getActive.mockResolvedValue([{ id: "same-id" }, { id: "other-render" }]);
    f.db.claimTaskWithinOwnerLimit.mockResolvedValue("busy");
    const entry = job();
    await expect(mocks.workers.get(MARKETING_VIDEO_QUEUE).run(entry, "lock-token")).rejects.toThrow();
    expect(f.db.claimTaskWithinOwnerLimit).toHaveBeenCalledWith("same-id", 1, "owner", ["other-render"], 1);
    expect(entry.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "lock-token");
    expect(handler).not.toHaveBeenCalled(); expect(f.db.setTaskError).not.toHaveBeenCalled(); expect(f.db.markTaskRunning).not.toHaveBeenCalled();
  });
  it("applies configured render concurrency and per-user limits", async () => {
    const f = fixture({ concurrency: 4, perUser: 2, segments: 2 }); f.queue.process("marketing.video", vi.fn());
    expect(mocks.workers.get(MARKETING_VIDEO_QUEUE).options.concurrency).toBe(4);
    await mocks.workers.get(MARKETING_VIDEO_QUEUE).run(job());
    expect(f.db.claimTaskWithinOwnerLimit).toHaveBeenCalledWith("same-id", 1, "owner", [], 2);
    expect(marketingQueueLimits({})).toEqual({ concurrency: 2, perUser: 1, segments: 2 });
    expect(marketingQueueLimits({ MARKETING_VIDEO_CONCURRENCY: "3", MARKETING_VIDEO_USER_CONCURRENCY: "2", MARKETING_VIDEO_SEGMENT_CONCURRENCY: "4" })).toEqual({ concurrency: 3, perUser: 2, segments: 4 });
    expect(() => marketingQueueLimits({ MARKETING_VIDEO_CONCURRENCY: "0" })).toThrow("MARKETING_VIDEO_CONCURRENCY");
    expect(() => marketingQueueLimits({ MARKETING_VIDEO_SEGMENT_CONCURRENCY: "16" })).toThrow("MARKETING_VIDEO_SEGMENT_CONCURRENCY must be an integer 1–15");
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

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
import {
  COMIC_IMAGE_QUEUE, COMIC_IMAGE_TASK, COMIC_RENDER_QUEUE, COMIC_RENDER_TASK, COMIC_VIDEO_QUEUE, COMIC_VIDEO_TASK,
  comicQueueLimits, DEFAULT_TASK_QUEUE, MARKETING_VIDEO_QUEUE, marketingPoolIssue, marketingQueueLimits, workerPoolIssue,
} from "./task-queues.js";

function fixture(limits = { concurrency: 2, perUser: 1, segments: 2 }) {
  const db = {
    createTask: vi.fn(), cancelTask: vi.fn(async () => true), markTaskRunning: vi.fn(async () => true),
    claimTaskWithinOwnerLimit: vi.fn(async (_id: string, _attempts: number, _owner: string, read: () => Promise<string[]>, _limit: number) => {
      await read();
      return "claimed" as "claimed" | "busy" | "stopped";
    }),
    getTask: vi.fn(async (id: string) => ({ id, type: id === "ordinary" ? "image.generate" : "marketing.video", status: "pending", input: { original: true }, user_id: "owner", created_at: "now", updated_at: "now" })),
    getTaskStatus: vi.fn(async () => "running"),
    setTaskResult: vi.fn(), setTaskError: vi.fn(), markTaskRetryPending: vi.fn(),
    findStalePendingTasks: vi.fn(async (): Promise<{ id: string; type?: string }[]> => [{ id: "old-task" }]), setPendingTaskDiagnostic: vi.fn(),
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
  it("delivers a marketing video again by its own ID once its delivery is confirmed missing", async () => {
    const f = fixture(); f.db.findStalePendingTasks.mockResolvedValue([{ id: "old-task", type: "marketing.video" }]);
    await f.queue.diagnosePending(180_000);
    expect(f.marketing.add).toHaveBeenCalledOnce();
    expect(f.marketing.add).toHaveBeenCalledWith("marketing.video", { taskId: "old-task" }, expect.objectContaining({ jobId: "old-task", attempts: 1 }));
    expect(f.db.setPendingTaskDiagnostic).toHaveBeenCalledWith("old-task", "等待队列处理");
    // Unknown queue state and other task types are only reported.
    const other = fixture(); other.db.findStalePendingTasks.mockResolvedValue([{ id: "ordinary", type: "image.generate" }]);
    await other.queue.diagnosePending(180_000);
    expect(other.ordinary.add).not.toHaveBeenCalled();
    expect(other.db.setPendingTaskDiagnostic).toHaveBeenCalledWith("ordinary", "投递未完成，可恢复排队");
    const unreadable = fixture(); unreadable.db.findStalePendingTasks.mockResolvedValue([{ id: "old-task", type: "marketing.video" }]);
    unreadable.marketing.getJob.mockRejectedValue(new Error("Redis unavailable"));
    await unreadable.queue.diagnosePending(180_000);
    expect(unreadable.marketing.add).not.toHaveBeenCalled();
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
    expect(f.db.setTaskError).toHaveBeenCalledWith("ordinary", "temporary", undefined);
  });
  it("stores the cause code of a typed worker error next to its message", async () => {
    const f = fixture(); f.queue.process("image.generate", async () => { throw Object.assign(new Error("timed out"), { errorCode: "TIMED_OUT" }); });
    await expect(mocks.workers.get(DEFAULT_TASK_QUEUE).run(job("ordinary", "image.generate"))).rejects.toThrow("timed out");
    expect(f.db.setTaskError).toHaveBeenCalledWith("ordinary", "timed out", "TIMED_OUT");
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
    expect(f.db.claimTaskWithinOwnerLimit).toHaveBeenCalledWith("same-id", 1, "owner", expect.any(Function), 1);
    await expect(f.db.claimTaskWithinOwnerLimit.mock.calls[0][3]()).resolves.toEqual(["same-id", "other-render"]);
    expect(entry.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "lock-token");
    expect(handler).not.toHaveBeenCalled(); expect(f.db.setTaskError).not.toHaveBeenCalled(); expect(f.db.markTaskRunning).not.toHaveBeenCalled();
  });
  it("applies configured render concurrency and per-user limits", async () => {
    const f = fixture({ concurrency: 4, perUser: 2, segments: 2 }); f.queue.process("marketing.video", vi.fn());
    expect(mocks.workers.get(MARKETING_VIDEO_QUEUE).options.concurrency).toBe(4);
    await mocks.workers.get(MARKETING_VIDEO_QUEUE).run(job());
    expect(f.db.claimTaskWithinOwnerLimit).toHaveBeenCalledWith("same-id", 1, "owner", expect.any(Function), 2);
    expect(marketingQueueLimits({})).toEqual({ concurrency: 2, perUser: 1, segments: 4 });
    expect(marketingQueueLimits({ MARKETING_VIDEO_CONCURRENCY: "3", MARKETING_VIDEO_USER_CONCURRENCY: "2", MARKETING_VIDEO_SEGMENT_CONCURRENCY: "4" })).toEqual({ concurrency: 3, perUser: 2, segments: 4 });
    expect(() => marketingQueueLimits({ MARKETING_VIDEO_CONCURRENCY: "0" })).toThrow("MARKETING_VIDEO_CONCURRENCY");
    expect(() => marketingQueueLimits({ MARKETING_VIDEO_SEGMENT_CONCURRENCY: "16" })).toThrow("MARKETING_VIDEO_SEGMENT_CONCURRENCY must be an integer 1–15");
  });
  it("skips mismatched persisted task types and job IDs before claiming", async () => {
    const f = fixture(), handler = vi.fn();
    f.queue.process("marketing.video", handler);
    const worker = mocks.workers.get(MARKETING_VIDEO_QUEUE);
    await worker.run(job("ordinary", "marketing.video"));
    await worker.run({ ...job(), id: "unrelated-job" });
    expect(handler).not.toHaveBeenCalled();
    expect(f.db.claimTaskWithinOwnerLimit).not.toHaveBeenCalled();
    expect(f.db.setTaskError).not.toHaveBeenCalled();
  });
  it("delays before submission when active queue membership is unreadable", async () => {
    const f = fixture(), handler = vi.fn();
    f.queue.process("marketing.video", handler);
    f.marketing.getActive.mockRejectedValueOnce(new Error("Redis disconnected"));
    const entry = job();
    await expect(mocks.workers.get(MARKETING_VIDEO_QUEUE).run(entry, "lock-token")).rejects.toThrow();
    expect(entry.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "lock-token");
    expect(handler).not.toHaveBeenCalled();
    expect(f.db.setTaskError).not.toHaveBeenCalled();
  });
  it("refuses to start when the worker pool cannot hold every render's lock beside its clips", () => {
    expect(marketingPoolIssue({ concurrency: 2 }, 20)).toBe("");
    expect(marketingPoolIssue({ concurrency: 9 }, 20)).toBe("");
    expect(marketingPoolIssue({ concurrency: 10 }, 20)).toContain("PG_POOL_MAX (20) must be at least 22");
    expect(marketingPoolIssue({ concurrency: 16 }, 34)).toBe("");
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

  it("isolates comic image/video/render queues with dedicated concurrency, non-retry, and legacy forwarding", async () => {
    const f = fixture();
    const comicImageId = await f.queue.enqueue(COMIC_IMAGE_TASK, { slot: 1 }, "owner");
    const comicVideoId = await f.queue.enqueue(COMIC_VIDEO_TASK, { slot: 2 }, "owner");
    const comicRenderId = await f.queue.enqueue(COMIC_RENDER_TASK, { slot: 3 }, "owner");
    expect(f.db.createTask).toHaveBeenCalledWith(comicImageId, COMIC_IMAGE_TASK, { slot: 1 }, "owner", COMIC_IMAGE_QUEUE);
    expect(f.db.createTask).toHaveBeenCalledWith(comicVideoId, COMIC_VIDEO_TASK, { slot: 2 }, "owner", COMIC_VIDEO_QUEUE);
    expect(f.db.createTask).toHaveBeenCalledWith(comicRenderId, COMIC_RENDER_TASK, { slot: 3 }, "owner", COMIC_RENDER_QUEUE);
    expect(mocks.queues.get(COMIC_IMAGE_QUEUE).add).toHaveBeenCalledOnce();
    expect(mocks.queues.get(COMIC_VIDEO_QUEUE).add).toHaveBeenCalledOnce();
    expect(mocks.queues.get(COMIC_RENDER_QUEUE).add).toHaveBeenCalledOnce();

    const renderHandler = vi.fn(async () => { throw Object.assign(new Error("disk low"), { errorCode: "RENDER_DISK_SPACE_LOW" }); });
    f.queue.process(COMIC_RENDER_TASK, renderHandler);
    expect(mocks.workers.get(COMIC_RENDER_QUEUE).options.concurrency).toBe(1);

    // Legacy comic render job sitting in lot-marketing-video is forwarded to lot-comic-render without claiming or executing.
    f.db.getTask.mockResolvedValue({
      id: "legacy-render", type: COMIC_RENDER_TASK, status: "pending", input: { original: true }, user_id: "owner", created_at: "now", updated_at: "now",
    });
    await mocks.workers.get(MARKETING_VIDEO_QUEUE).run(job("legacy-render", COMIC_RENDER_TASK));
    expect(mocks.queues.get(COMIC_RENDER_QUEUE).add).toHaveBeenCalledWith(
      COMIC_RENDER_TASK, { taskId: "legacy-render" }, expect.objectContaining({ jobId: "legacy-render", attempts: 1 }),
    );
    expect(renderHandler).not.toHaveBeenCalled();

    // Isolated comic queues never automatically retry paid/render jobs even if attempts > 1.
    const failingRender = { ...job("render-fail", COMIC_RENDER_TASK), opts: { attempts: 3 } };
    f.db.getTask.mockResolvedValue({
      id: "render-fail", type: COMIC_RENDER_TASK, status: "pending", input: { original: true }, user_id: "owner", created_at: "now", updated_at: "now",
    });
    await expect(mocks.workers.get(COMIC_RENDER_QUEUE).run(failingRender)).rejects.toThrow("disk low");
    expect(f.db.markTaskRetryPending).not.toHaveBeenCalled();
    expect(f.db.setTaskError).toHaveBeenCalledWith("render-fail", "disk low", "RENDER_DISK_SPACE_LOW");

    expect(comicQueueLimits({})).toEqual({
      imageConcurrency: 2, imagePerUser: 1,
      videoConcurrency: 2, videoPerUser: 1,
      renderConcurrency: 1, renderPerUser: 1,
    });
    expect(() => comicQueueLimits({ COMIC_RENDER_CONCURRENCY: "5" })).toThrow("COMIC_RENDER_CONCURRENCY must be an integer 1–4");
    expect(workerPoolIssue(marketingQueueLimits({}), comicQueueLimits({}), 20)).toBe("");
    expect(workerPoolIssue(marketingQueueLimits({}), comicQueueLimits({}), 15)).toContain("PG_POOL_MAX (15) must be at least 16");
  });
});

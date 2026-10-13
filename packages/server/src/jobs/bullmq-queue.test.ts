import { beforeEach, describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import type { DB } from "../db/database.js";
const mocks = vi.hoisted(() => ({ add: vi.fn(), getJob: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: class { add = mocks.add; getJob = mocks.getJob; }, Worker: class {} }));
import { BullmqJobQueue } from "./bullmq-queue.js";

describe("persisted business task delivery", () => {
  beforeEach(() => vi.resetAllMocks());
  const queue = () => new BullmqJobQueue({} as DB, {} as Redis);
  it("keeps the DB task ID and disables automatic paid retries", async () => {
    mocks.getJob.mockResolvedValue(undefined);
    await queue().deliverPersisted("task-id", "marketing.video");
    expect(mocks.add).toHaveBeenCalledWith("marketing.video", { taskId: "task-id" }, expect.objectContaining({ jobId: "task-id", attempts: 1 }));
  });
  it.each(["failed", "completed"] as const)("can explicitly resume a %s queue entry", async (state) => {
    const retry = vi.fn(); mocks.getJob.mockResolvedValue({ getState: async () => state, retry });
    expect(await queue().canResumePersisted("same-id")).toBe(true);
    await queue().deliverPersisted("same-id", "marketing.video");
    expect(retry).toHaveBeenCalledWith(state); expect(mocks.add).not.toHaveBeenCalled();
  });
  it.each(["active", "waiting", "delayed"])("does not replace a %s queue entry", async (state) => {
    const retry = vi.fn(); mocks.getJob.mockResolvedValue({ getState: async () => state, retry });
    expect(await queue().canResumePersisted("same-id")).toBe(false);
    await queue().deliverPersisted("same-id", "marketing.video");
    expect(retry).not.toHaveBeenCalled(); expect(mocks.add).not.toHaveBeenCalled();
  });
});

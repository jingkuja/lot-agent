import { expect, it, vi } from "vitest";
import { createAnalysisConsumer } from "./queue.js";
import { analysisUserAccess } from "./runtime.js";
import { ANALYSIS_JOB, ANALYSIS_RUN_LIMIT_MS } from "./config.js";
import { AnalysisError } from "./errors.js";
import type { PgAnalysisStore } from "./repository.js";

const transport = vi.hoisted(() => ({ process: undefined as undefined | ((job: unknown) => Promise<void>), close: vi.fn(async () => {}) }));
vi.mock("bullmq", () => ({ Worker: class {
  constructor(_name: string, process: typeof transport.process) { transport.process = process; }
  on() {}
  close = transport.close;
}, Queue: class {} }));

it.each(["lease lost", "shutdown"])("releases a worker stalled in model authorization on %s", async reason => {
  vi.useFakeTimers();
  const lease = { id: "analysis", ownerId: "owner", token: "lease", revision: 1 };
  const finish = vi.fn(async () => {});
  const store = { claim: async () => lease, heartbeat: vi.fn(async () => false), finish };
  const hub = { listModels: vi.fn(async () => new Promise<never>(() => {})) };
  const consumer = createAnalysisConsumer({}, 1, store as unknown as PgAnalysisStore, async (value, signal) => {
    await analysisUserAccess({ getUserApiKey: async () => "fixture-key" }, hub, value.ownerId, signal);
    throw new Error("Model must not be called after authorization is cancelled");
  });
  try {
    const running = transport.process!({ name: ANALYSIS_JOB, data: { taskId: lease.id } });
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.listModels).toHaveBeenCalledOnce();
    if (reason === "shutdown") await consumer.close();
    else await vi.advanceTimersByTimeAsync(2000);
    await running;
    expect(finish).toHaveBeenCalledWith(lease, "PROCESS_CANCELLED");
    expect(vi.getTimerCount()).toBe(0);
  } finally { await consumer.close(); vi.useRealTimers(); }
});

it("stops a run at the 10-minute limit and ends it resumable as ANALYSIS_TIMEOUT", async () => {
  vi.useFakeTimers();
  const lease = { id: "analysis", ownerId: "owner", token: "lease", revision: 1 };
  const finish = vi.fn(async () => {});
  const store = { claim: async () => lease, heartbeat: vi.fn(async () => true), finish };
  const consumer = createAnalysisConsumer({}, 1, store as unknown as PgAnalysisStore, (_value, signal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new AnalysisError("PROCESS_CANCELLED")), { once: true });
  }));
  try {
    const running = transport.process!({ name: ANALYSIS_JOB, data: { taskId: lease.id } });
    await vi.advanceTimersByTimeAsync(ANALYSIS_RUN_LIMIT_MS - 2000);
    expect(finish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await running;
    expect(finish).toHaveBeenCalledWith(lease, "ANALYSIS_TIMEOUT");
    expect(vi.getTimerCount()).toBe(0);
  } finally { await consumer.close(); vi.useRealTimers(); }
});

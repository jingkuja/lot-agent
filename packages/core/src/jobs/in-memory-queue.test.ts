import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryJobQueue } from "./in-memory-queue.js";

describe("InMemoryJobQueue", () => {
  let queue: InMemoryJobQueue;

  beforeEach(() => {
    queue = new InMemoryJobQueue();
  });

  it("handler registered before enqueue → job succeeds with output", async () => {
    queue.process<{ value: string }, { echoed: string }>(
      "echo",
      async (job) => ({ echoed: (job.input as { value: string }).value })
    );

    const id = await queue.enqueue("echo", { value: "hello" }, "user1");

    // Let the async microtask run
    await new Promise((r) => setTimeout(r, 0));

    const record = await queue.get(id);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("succeeded");
    expect((record!.output as { echoed: string }).echoed).toBe("hello");
    expect(record!.userId).toBe("user1");
    expect(record!.type).toBe("echo");
  });

  it("handler that throws → status failed, error populated", async () => {
    queue.process("fail-job", async () => {
      throw new Error("something went wrong");
    });

    const id = await queue.enqueue("fail-job", {}, "user1");
    await new Promise((r) => setTimeout(r, 0));

    const record = await queue.get(id);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("failed");
    expect(record!.error).toContain("something went wrong");
  });

  it("updateProgress sets progress and updatedAt", async () => {
    // Register a slow handler that we never actually resolve in this test
    queue.process("slow", async (_job) => {
      await new Promise((r) => setTimeout(r, 10000));
      return {};
    });

    const id = await queue.enqueue("slow", {}, "user1");
    // Immediately update progress before handler finishes
    await queue.updateProgress(id, 50);

    const record = await queue.get(id);
    expect(record).not.toBeNull();
    expect(record!.progress).toBe(50);
  });

  it("enqueue with no registered handler → status stays pending", async () => {
    const id = await queue.enqueue("unknown-type", { data: 1 }, "user1");
    await new Promise((r) => setTimeout(r, 0));

    const record = await queue.get(id);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("pending");
  });

  it("get returns null for unknown id", async () => {
    const record = await queue.get("nonexistent-id");
    expect(record).toBeNull();
  });

  it("enqueue returns a unique id each time", async () => {
    const id1 = await queue.enqueue("echo", {}, "user1");
    const id2 = await queue.enqueue("echo", {}, "user1");
    expect(id1).not.toBe(id2);
  });

  it("get returns a clone (mutations do not affect stored record)", async () => {
    queue.process("echo", async (job) => ({ echoed: job.input }));
    const id = await queue.enqueue("echo", { v: 1 }, "user1");
    await new Promise((r) => setTimeout(r, 0));

    const r1 = await queue.get(id);
    (r1 as Record<string, unknown>).status = "pending"; // mutate returned clone

    const r2 = await queue.get(id);
    expect(r2!.status).toBe("succeeded"); // internal record unchanged
  });
});

describe("InMemoryJobQueue v2", () => {
  let queue: InMemoryJobQueue;
  beforeEach(() => {
    queue = new InMemoryJobQueue();
  });

  it("delays execution by delayMs", async () => {
    let ran = false;
    queue.process("d", async () => {
      ran = true;
      return {};
    });
    await queue.enqueue("d", {}, "u", { delayMs: 40 });

    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toBe(false); // not yet
    await new Promise((r) => setTimeout(r, 60));
    expect(ran).toBe(true);
  });

  it("cancels a pending (delayed) job before it runs", async () => {
    let ran = false;
    queue.process("d", async () => {
      ran = true;
      return {};
    });
    const id = await queue.enqueue("d", {}, "u", { delayMs: 50 });

    const cancelled = await queue.cancel(id);
    await new Promise((r) => setTimeout(r, 70));

    expect(cancelled).toBe(true);
    expect(ran).toBe(false);
    expect((await queue.get(id))!.status).toBe("cancelled");
  });

  it("cancelling a running job aborts its signal and marks it cancelled", async () => {
    let aborted = false;
    queue.process("long", async (_job, ctl) => {
      await new Promise<void>((resolve) => {
        ctl.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
      throw new Error("aborted");
    });
    const id = await queue.enqueue("long", {}, "u");
    await new Promise((r) => setTimeout(r, 5)); // let it start

    const cancelled = await queue.cancel(id);
    await new Promise((r) => setTimeout(r, 10));

    expect(cancelled).toBe(true);
    expect(aborted).toBe(true);
    expect((await queue.get(id))!.status).toBe("cancelled");
  });

  it("retries a failing handler up to maxAttempts, then fails", async () => {
    let attempts = 0;
    queue.process("flaky", async () => {
      attempts++;
      throw new Error("boom");
    });
    const id = await queue.enqueue("flaky", {}, "u", { maxAttempts: 3 });
    await new Promise((r) => setTimeout(r, 20));

    const rec = await queue.get(id);
    expect(attempts).toBe(3);
    expect(rec!.status).toBe("failed");
    expect(rec!.attempts).toBe(3);
  });

  it("succeeds on a later attempt without exhausting retries", async () => {
    let attempts = 0;
    queue.process("recover", async () => {
      attempts++;
      if (attempts < 2) throw new Error("transient");
      return { ok: true };
    });
    const id = await queue.enqueue("recover", {}, "u", { maxAttempts: 3 });
    await new Promise((r) => setTimeout(r, 20));

    const rec = await queue.get(id);
    expect(rec!.status).toBe("succeeded");
    expect(rec!.attempts).toBe(2);
  });

  it("deduplicates by idempotencyKey: same id, runs once", async () => {
    let runs = 0;
    queue.process("once", async () => {
      runs++;
      return {};
    });
    const id1 = await queue.enqueue("once", {}, "u", { idempotencyKey: "k1" });
    const id2 = await queue.enqueue("once", {}, "u", { idempotencyKey: "k1" });
    await new Promise((r) => setTimeout(r, 10));

    expect(id1).toBe(id2);
    expect(runs).toBe(1);
  });

  it("updateProgress records the stage label", async () => {
    queue.process("slow", async () => {
      await new Promise((r) => setTimeout(r, 10000));
      return {};
    });
    const id = await queue.enqueue("slow", {}, "u");
    await queue.updateProgress(id, 30, "rendering");

    const rec = await queue.get(id);
    expect(rec!.progress).toBe(30);
    expect(rec!.stage).toBe("rendering");
  });

  it("cancel returns false for an unknown or already-finished job", async () => {
    queue.process("echo", async () => ({}));
    const id = await queue.enqueue("echo", {}, "u");
    await new Promise((r) => setTimeout(r, 10));

    expect(await queue.cancel("nope")).toBe(false);
    expect(await queue.cancel(id)).toBe(false); // already succeeded
  });
});

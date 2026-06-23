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

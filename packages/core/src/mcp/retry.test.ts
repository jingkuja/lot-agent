import { describe, it, expect, vi } from "vitest";
import { retryAsync } from "./retry.js";

const noSleep = async () => {};

describe("retryAsync", () => {
  it("returns immediately on first success", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await retryAsync(fn, { sleep: noSleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries then succeeds within the attempt budget", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 3) throw new Error("transient");
      return "recovered";
    });
    const result = await retryAsync(fn, { attempts: 3, sleep: noSleep });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after exhausting attempts", async () => {
    const fn = vi.fn(async () => {
      throw new Error("still failing");
    });
    await expect(retryAsync(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow("still failing");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("backs off with increasing delays between attempts", async () => {
    const delays: number[] = [];
    const fn = async () => {
      throw new Error("nope");
    };
    await retryAsync(fn, {
      attempts: 3,
      baseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => {});
    // Two waits between three attempts, exponential.
    expect(delays).toHaveLength(2);
    expect(delays[1]).toBeGreaterThan(delays[0]);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../../api/client.js";
import { recoverRead } from "./rate-limit-recovery.js";

const limited = (retryAfterMs?: number) => new ApiClientError("操作太频繁，请稍后再试。", 429, undefined, {}, retryAfterMs);

describe("recoverRead", () => {
  // The wait is shared by the whole page, so one clock runs through every test.
  beforeAll(() => { vi.useFakeTimers(); });
  afterAll(() => { vi.useRealTimers(); });
  afterEach(() => vi.advanceTimersByTimeAsync(120_000));

  it("waits for the limit to reset, then reads again", async () => {
    const send = vi.fn().mockRejectedValueOnce(limited(3_000)).mockResolvedValueOnce("ok");
    const result = recoverRead(send);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("holds other reads back during the wait", async () => {
    const first = vi.fn().mockRejectedValueOnce(limited(3_000)).mockResolvedValueOnce("a");
    const second = vi.fn().mockResolvedValue("b");
    const results = [recoverRead(first)];
    await vi.advanceTimersByTimeAsync(1_000);
    results.push(recoverRead(second));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(second).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(Promise.all(results)).resolves.toEqual(["a", "b"]);
  });

  it("caps the wait and gives up after two retries", async () => {
    const send = vi.fn().mockRejectedValue(limited(600_000));
    const result = recoverRead(send);
    const settled = expect(result).rejects.toThrow("操作太频繁");
    await vi.advanceTimersByTimeAsync(120_000);
    await settled;
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not retry other failures", async () => {
    const send = vi.fn().mockRejectedValue(new ApiClientError("读取失败", 500));
    await expect(recoverRead(send)).rejects.toThrow("读取失败");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

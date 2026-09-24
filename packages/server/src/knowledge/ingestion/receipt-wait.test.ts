import { afterEach, expect, it, vi } from "vitest";
import { waitForEmbeddingReceipts } from "./receipt-wait.js";
afterEach(() => vi.useRealTimers());
it("waits for delayed gateway receipts without retrying the document", async () => {
  const reconcile = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
  await waitForEmbeddingReceipts(reconcile, undefined, 3000);
  expect(reconcile).toHaveBeenCalledTimes(3);
});
it("bounds an unreconciled receipt and keeps it retryable", async () => {
  await expect(waitForEmbeddingReceipts(async () => false, undefined, 0)).rejects.toMatchObject({ message: "EMBEDDING_BILLING_PENDING", retryable: true });
});
it("stops waiting immediately on cancellation", async () => {
  const controller = new AbortController();
  const pending = waitForEmbeddingReceipts(async () => false, controller.signal);
  const assertion = expect(pending).rejects.toThrow(); controller.abort(); await assertion;
});

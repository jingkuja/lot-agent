import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ProbeCallLedger } from "./probe-ledger.js";
import { readAnalysisFile } from "./private-files.js";

describe("durable probe intents", () => {
  it("blocks unknown replay across instances and reserves parallel image budgets atomically", async () => {
    const folder = await mkdtemp(join(tmpdir(), "lot-probe-ledger-"));
    try {
      const ledger = new ProbeCallLedger(folder, async () => {}, { calls: 5, images: 1 });
      const results = await Promise.allSettled([ledger.begin("a", "hash-a", "kimi-k3", 1), ledger.begin("b", "hash-b", "kimi-k3", 1)]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const restored = new ProbeCallLedger(folder, async () => {});
      await expect(restored.begin("a", "hash-a", "kimi-k3", 1)).rejects.toThrow("REQUEST_UNKNOWN");
      await expect(restored.begin("a", "changed", "kimi-k3", 1)).rejects.toThrow("STEP_INPUT_CHANGED");
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it("commits usage before bookkeeping and recovers bookkeeping without another call", async () => {
    const folder = await mkdtemp(join(tmpdir(), "lot-probe-ledger-"));
    try {
      const account = vi.fn().mockRejectedValueOnce(new Error("DB_DOWN")).mockResolvedValue(undefined);
      const ledger = new ProbeCallLedger(folder, account);
      await ledger.begin("ocr:f0001", "hash", "deepseek-v4.1-flash", 1);
      const receipt = { text: '{"text":"99"}', outcome: "completed" as const, usage: { promptTokens: 20, completionTokens: 5 } };
      await expect(ledger.finish("ocr:f0001", receipt)).rejects.toThrow("DB_DOWN");
      expect(await ledger.begin("ocr:f0001", "hash", "deepseek-v4.1-flash", 1)).toEqual(receipt);
      expect(account).toHaveBeenCalledTimes(2);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it("keeps failed calls inside the original call and image caps when the operator continues", async () => {
    const folder = await mkdtemp(join(tmpdir(), "lot-probe-budget-"));
    try {
      const ledger = new ProbeCallLedger(folder, async () => {}, { calls: 2, images: 2 });
      const failed = { text: "", outcome: "failed" as const, usage: { promptTokens: 713, completionTokens: 8192 } };
      await ledger.begin("ocr:f0035", "hash-35", "deepseek-v4.1-flash", 1);
      await ledger.finish("ocr:f0035", failed);
      await ledger.begin("ocr:f0036", "hash-36", "deepseek-v4.1-flash", 1);
      await ledger.finish("ocr:f0036", { text: '{"text":"99元"}', outcome: "completed", usage: { promptTokens: 713, completionTokens: 100 } });
      await expect(ledger.begin("ocr:f0037", "hash-37", "deepseek-v4.1-flash", 1)).rejects.toThrow("MODEL_BUDGET_EXHAUSTED");
      expect(await ledger.begin("ocr:f0035", "hash-35", "deepseek-v4.1-flash", 1)).toEqual(failed);
      expect(await ledger.records()).toHaveLength(2);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it("rejects traversal, symlinks and oversized private frame files", async () => {
    const folder = await mkdtemp(join(tmpdir(), "lot-probe-files-"));
    try {
      await writeFile(join(folder, "frame-0001.jpg"), "12345");
      await symlink(join(folder, "frame-0001.jpg"), join(folder, "frame-0002.jpg"));
      await expect(readAnalysisFile(folder, "../secret", 10)).rejects.toThrow("INVALID_PRIVATE_FILE");
      await expect(readAnalysisFile(folder, "frame-0001.jpg", 4)).rejects.toThrow("INVALID_PRIVATE_FILE");
      await expect(readAnalysisFile(folder, "frame-0002.jpg", 10)).rejects.toThrow();
      expect((await readAnalysisFile(folder, "frame-0001.jpg", 10)).toString()).toBe("12345");
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
});

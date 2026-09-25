import { expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseIsolated } from "./parser-process.js";
it("runs the real parser in isolation with a source locator", async () => {
  const path = fileURLToPath(new URL("../../workers/knowledge-parser.ts", import.meta.url));
  const result = await parseIsolated(path, { mime: "text/plain", content: "正文\n最后一行" });
  expect(result.blocks.at(-1)?.citation).toEqual({ kind: "text", startLine: 2, endLine: 2 });
});
it("terminates a stuck parser on timeout and cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rag-parser-test-"));
  try {
    const path = join(dir, "stuck.mjs"); await writeFile(path, "while (true) {}");
    await expect(parseIsolated(path, { mime: "text/plain" }, undefined, 30)).rejects.toThrow("PARSER_TIMEOUT");
    const controller = new AbortController(); const result = parseIsolated(path, { mime: "text/plain" }, controller.signal);
    controller.abort(); await expect(result).rejects.toThrow("PARSER_CANCELLED");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("delegates OCR from the isolated parser without passing credentials to it", async () => {
  const path = fileURLToPath(new URL("../../workers/knowledge-parser.ts", import.meta.url));
  const result = await parseIsolated(path, { mime: "image/png", bytes: new Uint8Array([1, 2]) }, undefined, 30000, async (image) => {
    expect(image.mime).toBe("image/png"); expect([...image.bytes]).toEqual([1, 2]); return "识别正文";
  });
  expect(result.blocks).toEqual([{ text: "识别正文", origin: "ocr" }]);
});
it("propagates OCR failures and aborts an in-flight OCR call", async () => {
  const path = fileURLToPath(new URL("../../workers/knowledge-parser.ts", import.meta.url));
  await expect(parseIsolated(path, { mime: "image/png", bytes: new Uint8Array([1]) }, undefined, 30000, async () => {
    throw Object.assign(new Error("OCR_REQUEST_FAILED"), { retryable: true });
  })).rejects.toMatchObject({ message: "OCR_REQUEST_FAILED", retryable: true });
  const controller = new AbortController();
  await expect(parseIsolated(path, { mime: "image/png", bytes: new Uint8Array([1]) }, controller.signal, 30000, async (_, signal) => {
    controller.abort(); expect(signal?.aborted).toBe(true); throw new Error("INGESTION_CANCELLED");
  })).rejects.toThrow("PARSER_CANCELLED");
});

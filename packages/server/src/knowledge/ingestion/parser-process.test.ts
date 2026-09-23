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

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { RecognizeImage } from "./ocr.js";
import type { ParseInput, ParsedArtifact } from "./parsers.js";

export async function extractWebPdfText(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  // tsup puts the shared parser code at the dist root and preserves the worker entry path.
  const workerEntry = import.meta.url.endsWith(".ts") ? "../../workers/knowledge-parser.ts" : "./workers/knowledge-parser.js";
  const workerPath = fileURLToPath(new URL(workerEntry, import.meta.url));
  const parsed = await parseIsolated(workerPath, { mime: "application/pdf", bytes: new Uint8Array(bytes) }, signal, 12_000);
  return parsed.blocks.map((block) => block.text).join("\n\n");
}

export function parseIsolated(workerPath: string, input: ParseInput & { path?: string }, signal?: AbortSignal, timeoutMs = 30000, ocr?: RecognizeImage): Promise<ParsedArtifact> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("PARSER_CANCELLED")); return; }
    const source = workerPath.endsWith(".ts")
      ? new URL("data:text/javascript," + encodeURIComponent(
        `import { tsImport } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)}; await tsImport(${JSON.stringify(pathToFileURL(workerPath).href)}, ${JSON.stringify(import.meta.url)});`))
      : workerPath;
    const worker = new Worker(source, {
      workerData: { ...input, ocrEnabled: Boolean(ocr) }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      execArgv: [],
      stdout: true, stderr: true,
    });
    // Parser diagnostics may contain document fragments. Never forward child output.
    worker.stdout?.resume(); worker.stderr?.resume();
    const controller = new AbortController();
    let settled = false; let recognizing = false;
    const finish = (error?: Error, result?: ParsedArtifact) => {
      if (settled) return; settled = true;
      controller.abort(); clearTimeout(timer); signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error("PARSER_CANCELLED"));
    let timer = setTimeout(() => finish(new Error("PARSER_TIMEOUT")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", async (message) => {
      if (settled) return;
      if (message.type === "ocr") {
        if (!ocr || recognizing) { finish(new Error("PARSER_FAILED")); return; }
        recognizing = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error("OCR_TIMEOUT")), 135000);
        try {
          const text = await ocr(message.image, controller.signal);
          if (settled) return;
          recognizing = false; clearTimeout(timer);
          timer = setTimeout(() => finish(new Error("PARSER_TIMEOUT")), timeoutMs);
          worker.postMessage({ type: "ocr-result", text });
        } catch (error) { finish(error instanceof Error ? error : new Error("OCR_FAILED")); }
        return;
      }
      finish(message.ok ? undefined : new Error(message.code), message.result);
    });
    worker.once("error", () => finish(new Error("PARSER_FAILED")));
    worker.once("exit", () => { if (!settled) finish(new Error("PARSER_FAILED")); });
  });
}

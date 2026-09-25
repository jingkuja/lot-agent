import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { RecognizeImage } from "./ocr.js";
import type { ParseInput, ParsedArtifact } from "./parsers.js";

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

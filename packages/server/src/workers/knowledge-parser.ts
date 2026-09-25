import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { parseKnowledge, type ParseInput } from "../knowledge/ingestion/parsers.js";
import type { RecognizeImage } from "../knowledge/ingestion/ocr.js";
const input = workerData as ParseInput & { path?: string; ocrEnabled?: boolean };
const ocr: RecognizeImage = (image) => new Promise((resolve) => {
  parentPort!.once("message", (message) => resolve(message.text));
  parentPort!.postMessage({ type: "ocr", image });
});
try {
  if (input.path) input.bytes = await readFile(input.path);
  parentPort!.postMessage({ ok: true, result: await parseKnowledge(input, input.ocrEnabled ? ocr : undefined) });
} catch (error) {
  const message = error instanceof Error ? error.message : "PARSER_FAILED";
  parentPort!.postMessage({ ok: false, code: /^[A-Z_]{1,64}$/.test(message) ? message : /password/i.test(message) ? "PASSWORD_REQUIRED" : "PARSER_FAILED" });
}

import { afterEach, expect, it, vi } from "vitest";
import { createUserOcr, OCR_MODEL, OCR_PROMPT } from "./ocr.js";
import type { DB } from "../../db/database.js";
import type { UsageMeter } from "../../billing/meter.js";
const image = { mime: "image/png", bytes: new Uint8Array([1, 2, 3]) };
function setup(key: string | null = "owner-key") {
  const db = { getUserApiKey: vi.fn().mockResolvedValue(key) };
  const meter = { checkQuota: vi.fn().mockResolvedValue({ ok: true }), record: vi.fn().mockResolvedValue(0.01) };
  const run = createUserOcr({ db: db as unknown as DB, meter: meter as unknown as UsageMeter, ownerId: "owner", taskId: "task", baseUrl: "https://gateway.invalid/v1", estimatedCost: 0.1 });
  return { run, db, meter };
}
const response = (finish = "stop", content = "合同\n金额：100元") => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
afterEach(() => vi.unstubAllGlobals());
it("sends the requested model, OCR prompt and image with the owner's key and meters usage", async () => {
  const fetcher = vi.fn().mockResolvedValue(response()); vi.stubGlobal("fetch", fetcher);
  const { run, db, meter } = setup();
  expect(await run(image)).toBe("合同\n金额：100元");
  expect(db.getUserApiKey).toHaveBeenCalledWith("owner", expect.any(Boolean));
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe("https://gateway.invalid/v1/chat/completions");
  expect(init.headers.Authorization).toBe("Bearer owner-key");
  const body = JSON.parse(init.body);
  expect(body.model).toBe("deepseek-v4.1-flash");
  expect(body.messages[0].content).toBe(OCR_PROMPT);
  expect(body.messages[1].content[1]).toMatchObject({ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } });
  expect(meter.record).toHaveBeenCalledWith({ userId: "owner", taskId: "task", modelId: OCR_MODEL, usage: { inputCount: 100, outputCount: 20 } });
});
it("does not call the provider without a user key, quota or after cancellation", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(setup(null).run(image)).rejects.toThrow("OCR_CREDENTIAL_REQUIRED");
  const { run, meter } = setup(); meter.checkQuota.mockResolvedValue({ ok: false });
  await expect(run(image)).rejects.toThrow("OCR_QUOTA_EXCEEDED");
  await expect(run(image, AbortSignal.abort())).rejects.toThrow("INGESTION_CANCELLED");
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects truncation after recording paid usage and accepts an explicit no-text result", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response("length")).mockResolvedValueOnce(response("stop", "<NO_TEXT>")));
  const { run, meter } = setup();
  await expect(run(image)).rejects.toThrow("OCR_OUTPUT_TRUNCATED");
  expect(meter.record).toHaveBeenCalledTimes(1);
  expect(await run(image)).toBe("");
});
it("sanitizes provider errors and requires usage accounting", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("sensitive provider detail", { status: 429 })).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "text" }, finish_reason: "stop" }] }))));
  const { run } = setup();
  await expect(run(image)).rejects.toMatchObject({ message: "OCR_RATE_LIMITED", retryable: true });
  await expect(run(image)).rejects.toThrow("OCR_USAGE_MISSING");
});

it.each([
  [401, "OCR_AUTH_FAILED", false],
  [403, "OCR_ACCESS_DENIED", false],
  [404, "OCR_MODEL_UNAVAILABLE", false],
  [400, "OCR_INVALID_REQUEST", false],
  [429, "OCR_RATE_LIMITED", true],
  [503, "OCR_PROVIDER_UNAVAILABLE", true],
])("classifies HTTP %s without exposing the gateway response", async (status, code, retryable) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private upstream diagnostics", { status })));
  await expect(setup().run(image)).rejects.toMatchObject({ message: code, retryable });
});
it("distinguishes network failures, timeouts and cancellation", async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("private host")).mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
  vi.stubGlobal("fetch", fetcher);
  await expect(setup().run(image)).rejects.toThrow("OCR_NETWORK_ERROR");
  await expect(setup().run(image)).rejects.toThrow("OCR_TIMEOUT");
});
it("uses a separate image description prompt on fallback and meters the call", async () => {
  const fetcher = vi.fn().mockResolvedValue(response("stop", "蓝色陶瓷杯，白色背景。")); vi.stubGlobal("fetch", fetcher);
  const { run, meter } = setup();
  expect(await run({ ...image, mode: "describe" })).toBe("蓝色陶瓷杯，白色背景。");
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.model).toBe(OCR_MODEL);
  expect(body.messages[0].content).toContain("图片说明");
  expect(body.messages[0].content).not.toBe(OCR_PROMPT);
  expect(meter.record).toHaveBeenCalledTimes(1);
});

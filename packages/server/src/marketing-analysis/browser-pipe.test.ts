import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { BrowserPipe } from "./browser-pipe.js";
import { AnalysisError } from "./errors.js";

describe("private browser protocol pipe", () => {
  it("correlates out-of-order responses and preserves split UTF-8 frames", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const pipe = new BrowserPipe(input, output);
    const event = vi.fn(); pipe.onEvent = event;
    const first = pipe.send("Browser.getVersion"), second = pipe.send("Runtime.evaluate", {}, "page");
    expect(input.read().toString()).toContain('"sessionId":"page"');
    const data = Buffer.from(JSON.stringify({ id: 2, result: { title: "公开播放" } }) + "\0"
      + JSON.stringify({ method: "Fetch.requestPaused", params: { requestId: "r1" }, sessionId: "page" }) + "\0"
      + JSON.stringify({ id: 1, result: { product: "Chromium" } }) + "\0");
    for (const byte of data) output.write(Buffer.from([byte]));
    await expect(first).resolves.toEqual({ product: "Chromium" });
    await expect(second).resolves.toEqual({ title: "公开播放" });
    expect(event).toHaveBeenCalledWith(expect.objectContaining({ method: "Fetch.requestPaused", sessionId: "page" }));
    pipe.close();
  });
  it.each(["{invalid}\0", "x".repeat(2 * 1024 * 1024 + 1)])("fails closed on invalid or excessive protocol data", async data => {
    const output = new PassThrough(); const pipe = new BrowserPipe(new PassThrough(), output);
    const pending = expect(pipe.send("Browser.getVersion")).rejects.toThrow("BROWSER_READ_FAILED");
    output.write(data); await pending;
    await expect(pipe.send("Runtime.evaluate")).rejects.toThrow("BROWSER_READ_FAILED");
  });
  it("cancels all pending requests and preserves the finite failure code", async () => {
    const pipe = new BrowserPipe(new PassThrough(), new PassThrough());
    const requests = [pipe.send("Browser.getVersion"), pipe.send("Runtime.evaluate")];
    const assertions = requests.map(p => expect(p).rejects.toThrow("PROCESS_CANCELLED"));
    pipe.close(new AnalysisError("PROCESS_CANCELLED")); pipe.close();
    await Promise.all(assertions);
    expect(() => pipe.throwIfClosed()).toThrow("PROCESS_CANCELLED");
  });
  it("does not expose remote protocol error text", async () => {
    const output = new PassThrough(); const pipe = new BrowserPipe(new PassThrough(), output);
    const pending = expect(pipe.send("Runtime.evaluate")).rejects.toThrow(/^BROWSER_READ_FAILED$/);
    output.write(JSON.stringify({ id: 1, error: { message: "private upstream detail" } }) + "\0"); await pending;
    pipe.close();
  });
});

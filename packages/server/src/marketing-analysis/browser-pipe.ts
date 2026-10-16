import type { Readable, Writable } from "node:stream";
import { AnalysisError } from "./errors.js";

/** Chromium's private, NUL-delimited CDP pipe. No debugging TCP port is opened. */
export class BrowserPipe {
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private failure?: Error;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  onEvent?: (message: { method: string; params: any; sessionId?: string }) => void;

  constructor(private input: Writable, output: Readable) {
    output.on("data", (chunk: Buffer) => this.read(chunk));
    output.once("error", () => this.close());
    output.once("end", () => this.close());
    input.once("error", () => this.close());
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 128) return Promise.reject(new AnalysisError("BROWSER_READ_FAILED"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0", error => {
        if (error) this.close();
      });
    });
  }
  throwIfClosed() { if (this.failure) throw this.failure; }
  close(error: Error = new AnalysisError("BROWSER_READ_FAILED")) {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear(); this.buffer = Buffer.alloc(0);
  }
  private read(chunk: Buffer) {
    if (this.failure) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 2 * 1024 * 1024) { this.close(); return; }
    for (let end; (end = this.buffer.indexOf(0)) >= 0;) {
      const data = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
      try {
        const message = JSON.parse(data.toString("utf8"));
        if (typeof message.id === "number") {
          const request = this.pending.get(message.id); this.pending.delete(message.id);
          if (message.error) request?.reject(new AnalysisError("BROWSER_READ_FAILED"));
          else request?.resolve(message.result);
        } else if (typeof message.method === "string") this.onEvent?.(message);
      } catch { this.close(); return; }
    }
  }
}

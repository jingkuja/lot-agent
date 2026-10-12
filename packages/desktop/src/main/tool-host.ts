import { setTimeout as delay } from "node:timers/promises";
import { realpath } from "node:fs/promises";
import { BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron";
import { executeLocalTool, findBash } from "./local-tools.js";
import type { LocalToolRequest } from "../../../core/src/desktop/protocol.js";

interface Run {
  capability: string;
  controller: AbortController;
  operation?: { id: string; controller: AbortController };
  baseUrl: string;
  token: string;
  attached: boolean;
}
export interface ToolHostContext {
  getWindow(): BrowserWindow | null;
  getServerUrl(): string | null;
  getToken(): string | null;
  getRendererOrigin(): string;
}

export class DesktopToolHost {
  private root: string | null = null;
  private runs = new Map<string, Run>();
  private generation = 0;
  private preparing = new Set<string>();
  constructor(private ctx: ToolHostContext) {}
  assertSender(event: IpcMainInvokeEvent) {
    const win = this.ctx.getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || new URL(event.senderFrame.url).origin !== this.ctx.getRendererOrigin()) throw new Error("Untrusted desktop sender");
  }
  async state() { return { directory: this.root, bashAvailable: !!await findBash(), activeRuns: this.runs.size }; }
  async choose() {
    const win = this.ctx.getWindow();
    if (!win || this.runs.size || this.preparing.size) throw new Error("Stop local tasks before changing the directory");
    const generation = this.generation;
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "选择本地工作目录 / Choose local working directory" });
    if (!result.canceled && result.filePaths[0]) {
      const root = await realpath(result.filePaths[0]);
      if (generation !== this.generation || this.runs.size || this.preparing.size) throw new Error("Desktop state changed; select the directory again");
      this.root = root;
    }
    return this.state();
  }
  reset() {
    this.generation++;
    this.root = null;
    for (const id of this.runs.keys()) this.finish(id);
  }
  /** Only the trusted webContents message POST receives a one-use capability.
   * Remove forged headers even for the trusted renderer. Never expose secrets
   * through preload, localStorage, SSE or persistent chat metadata. */
  attachHeader(url: string, webContentsId: number, method: string, headers: Record<string, string>): Record<string, string> {
    for (const key of Object.keys(headers)) if (key.toLowerCase() === "x-lot-desktop-capability") delete headers[key];
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (parsed.origin !== this.ctx.getRendererOrigin() || webContentsId !== this.ctx.getWindow()?.webContents.id || method !== "POST" || !match) return headers;
    const run = this.runs.get(decodeURIComponent(match[1]));
    if (run && !run.attached) {
      headers["X-Lot-Desktop-Capability"] = run.capability;
      run.attached = true;
    }
    return headers;
  }
  private async request(run: Run, id: string, suffix: string, method = "GET", body?: unknown) {
    return fetch(`${run.baseUrl}/api/conversations/${encodeURIComponent(id)}/desktop-tools/${suffix}`, {
      method, redirect: "error", headers: { Authorization: `Bearer ${run.token}`, "Content-Type": "application/json", "X-Lot-Desktop-Capability": run.capability },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(10000)]),
    });
  }
  async prepare(id: string) {
    if (!this.root) return false;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid conversation");
    if (this.runs.has(id) || this.preparing.has(id)) throw new Error("Local turn already active");
    const root = this.root;
    const generation = this.generation;
    const token = this.ctx.getToken();
    const baseUrl = this.ctx.getServerUrl();
    if (!token || !baseUrl) throw new Error("Sign in and configure the desktop server first");
    const run: Run = { capability: "", controller: new AbortController(), token, baseUrl, attached: false };
    this.preparing.add(id);
    try {
      const response = await this.request(run, id, "session", "POST");
      // Other specialized agents retain their established tool allowlists.
      if (response.status === 403) return false;
      if (!response.ok) throw new Error("Local tools connection failed. Check the server version and your login.");
      const data = await response.json() as { capability?: string };
      if (!data.capability || !/^[a-f0-9]{64}$/.test(data.capability)) throw new Error("Invalid desktop capability");
      run.capability = data.capability;
      this.runs.set(id, run);
      if (generation !== this.generation) { this.finish(id); throw new Error("Desktop authorization changed"); }
      void this.poll(id, root, run);
      return true;
    } finally { this.preparing.delete(id); }
  }
  finish(id: string) {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.delete(id);
    run.operation?.controller.abort();
    run.controller.abort();
    // Best effort revocation; no retry and no credentials follow redirects.
    void fetch(`${run.baseUrl}/api/conversations/${encodeURIComponent(id)}/desktop-tools/session`, {
      method: "DELETE", redirect: "error", headers: { Authorization: `Bearer ${run.token}`, "X-Lot-Desktop-Capability": run.capability }, signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
  private async poll(id: string, root: string, run: Run) {
    try {
      while (!run.controller.signal.aborted) {
        const response = await this.request(run, id, "session");
        if (!response.ok) break;
        const data = await response.json() as { request: LocalToolRequest | null; activeRequestId: string | null };
        if (run.operation && data.activeRequestId !== run.operation.id) run.operation.controller.abort();
        if (data.request) {
          if (run.operation) throw new Error("Concurrent local request rejected");
          const operation = { id: data.request.id, controller: new AbortController() };
          run.operation = operation;
          // Poll independently while executing so server cancellation also kills
          // a command while it is waiting for approval or producing output.
          void this.execute(id, root, run, data.request, operation);
        }
        await delay(500, undefined, { signal: run.controller.signal });
      }
    } catch { /* Fail closed on disconnect; a write is never redelivered. */ }
    finally { if (this.runs.get(id) === run) this.finish(id); }
  }
  private async execute(id: string, root: string, run: Run, request: LocalToolRequest, operation: NonNullable<Run["operation"]>) {
    try {
      const signal = AbortSignal.any([run.controller.signal, operation.controller.signal]);
      const result = await executeLocalTool(root, request, signal, async (detail, approvalSignal) => {
        const win = this.ctx.getWindow();
        if (!win || approvalSignal.aborted) return false;
        const isBash = request.name === "desktop_bash";
        // Native confirmation is not a model tool waiting on a chat reply.
        // No changes execute after a cancelled/expired confirmation.
        const answer = await dialog.showMessageBox(win, {
          type: "warning", title: "本地操作确认 / Confirm local operation",
          message: isBash ? "允许执行此 Bash 命令？/ Run this Bash command?" : "允许修改此本地文件？/ Change this local file?",
          detail: `${isBash ? "Bash 可访问工作目录以外的文件及网络。/ Bash can access files outside the workspace and the network.\n\n" : ""}${detail}`,
          buttons: ["取消 / Cancel", "执行 / Run"], defaultId: 0, cancelId: 0, noLink: true, signal: approvalSignal,
        });
        return answer.response === 1 && !approvalSignal.aborted;
      });
      if (!signal.aborted) {
        const response = await this.request(run, id, "result", "POST", { id: request.id, result });
        if (!response.ok) throw new Error("Local result was not accepted");
      }
    } catch { if (this.runs.get(id) === run) this.finish(id); }
    finally { if (run.operation === operation) run.operation = undefined; }
  }
}

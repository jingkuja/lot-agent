import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getTask: vi.fn(), getConversation: vi.fn(), videoCopy: vi.fn(), generate: vi.fn() }));
vi.mock("./miniprogram/services/api", () => ({ api, absoluteMedia: (url: string) => url || "" }));
let page: any;
let app: any;
let saved: Record<string, any>;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  saved = {}; app = { ensureSession: vi.fn().mockResolvedValue(true), globalData: { user: { id: "owner" } } };
  vi.stubGlobal("getApp", () => app);
  vi.stubGlobal("wx", { getStorageSync: vi.fn((key) => saved[key]), setStorageSync: vi.fn((key, value) => { saved[key] = value; }), showToast: vi.fn() });
  vi.stubGlobal("Page", (definition: any) => { page = { ...definition, data: structuredClone(definition.data), setData(update: any) { Object.assign(this.data, update); } }; });
  await import("./miniprogram/pages/video/index");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("video draft recovery", () => {
  it("restores a task after a restart and persists its completed video without generating again", async () => {
    saved["lot:video:owner"] = { draft: { script: "旧文案" }, conversationId: "conv", taskId: "task", pending: true };
    api.getTask.mockResolvedValue({ status: "succeeded", output: { assets: [{ url: "/static/assets/video.mp4" }] } });
    await page.onShow(); await vi.advanceTimersByTimeAsync(0);
    expect(page.data).toMatchObject({ step: 6, pending: false, resultUrl: "/static/assets/video.mp4" });
    expect(saved["lot:video:owner"].resultUrl).toBe("/static/assets/video.mp4"); expect(api.generate).not.toHaveBeenCalled();
  });
  it("preserves an unconfirmed submission and prevents another generation", async () => {
    saved["lot:video:owner"] = { conversationId: "conv", pending: true };
    api.getConversation.mockResolvedValue({ messages: [] });
    await page.onShow(); await vi.advanceTimersByTimeAsync(0); await page.generate();
    expect(page.data.pending).toBe(true); expect(page.data.status).toContain("待确认"); expect(api.generate).not.toHaveBeenCalled();
    page.onHide(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not put a late response from the previous account into the current draft", async () => {
    let finish: (task: unknown) => void = () => {};
    api.getTask.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    saved["lot:video:owner"] = { conversationId: "conv", taskId: "task", pending: true };
    await page.onShow();
    app.globalData.user.id = "other"; await page.onShow();
    finish({ status: "succeeded", output: { assets: [{ url: "private-video.mp4" }] } }); await vi.advanceTimersByTimeAsync(0);
    expect(page.data.resultUrl).toBe(""); expect(page.data.conversationId).toBe("");
  });
  it("keeps offline tasks pending and resumes polling when shown", async () => {
    saved["lot:video:owner"] = { conversationId: "conv", taskId: "task", pending: true };
    api.getTask.mockRejectedValue(new Error("offline"));
    await page.onShow(); await vi.advanceTimersByTimeAsync(0); expect(page.data.pending).toBe(true);
    page.onHide(); expect(vi.getTimerCount()).toBe(0);
    await page.onShow(); await vi.advanceTimersByTimeAsync(0); expect(api.getTask).toHaveBeenCalledTimes(2);
  });
});

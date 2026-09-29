import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getTask: vi.fn(), getConversation: vi.fn(), videoCopy: vi.fn(), generate: vi.fn(), createConversation: vi.fn(), deleteConversation: vi.fn() }));
vi.mock("./miniprogram/services/api", () => ({ api, absoluteMedia: (url: string) => url || "" }));
let page: any;
let app: any;
let saved: Record<string, any>;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  saved = {}; app = { ensureSession: vi.fn().mockResolvedValue(true), globalData: { user: { id: "owner" } } };
  vi.stubGlobal("getApp", () => app);
  vi.stubGlobal("wx", { getStorageSync: vi.fn((key) => saved[key]), setStorageSync: vi.fn((key, value) => { saved[key] = value; }), showToast: vi.fn(), showModal: vi.fn(({ success }) => success?.({ confirm: true })), chooseMedia: vi.fn() });
  vi.stubGlobal("Page", (definition: any) => { page = { ...definition, data: structuredClone(definition.data), setData(update: any) { for (const [key, value] of Object.entries(update)) { const parts = key.split("."); if (parts.length === 2) this.data[parts[0]][parts[1]] = value; else this.data[key] = value; } } }; });
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

describe("video operation guards", () => {
  beforeEach(async () => {
    await page.onShow();
    page.data.draft.script = "清晨咖啡馆";
    api.createConversation.mockResolvedValue({ id: "conv" });
    api.generate.mockResolvedValue({ taskId: "task" });
    api.getTask.mockResolvedValue({ status: "running", progress: 20 });
  });
  it("locks before session awaits so rapid taps submit and confirm only once", async () => {
    await Promise.all([page.generate(), page.generate(), page.generate()]);
    expect(wx.showModal).toHaveBeenCalledTimes(1);
    expect(api.generate).toHaveBeenCalledTimes(1);
    expect(page.data).toMatchObject({ pending: true, step: 6 });
  });
  it("does not submit or erase the previous result when confirmation is cancelled", async () => {
    vi.mocked(wx.showModal).mockImplementation(({ success }) => success?.({ confirm: false, cancel: true }));
    page.data.resultUrl = "old.mp4";
    await page.generate();
    expect(api.generate).not.toHaveBeenCalled();
    expect(page.data.resultUrl).toBe("old.mp4");
    expect(page.data.busy).toBe(false);
  });
  it("cannot discard a pending task or modify its settings", () => {
    page.data.pending = true; page.data.conversationId = "conv";
    page.newDraft(); page.toggleSubtitles({ detail: { value: false } });
    page.choose({ currentTarget: { dataset: { field: "voice", value: "无配音" } } });
    expect(page.data.conversationId).toBe("conv"); expect(page.data.pending).toBe(true);
    expect(page.data.draft.subtitles).toBe(true); expect(page.data.draft.voice).toBe("自然旁白");
    expect(wx.showModal).not.toHaveBeenCalled();
  });
  it("does not overwrite a locked draft with a late image picker callback", () => {
    page.chooseImage({ currentTarget: { dataset: { field: "cover" } } });
    const callback = vi.mocked(wx.chooseMedia).mock.calls[0][0].success!;
    page.data.pending = true;
    callback({ tempFiles: [{ tempFilePath: "late.png" }] } as any);
    expect(page.data.draft.cover).toBe("");
  });
  it("blocks unchanged successful settings even after a restart", async () => {
    api.getTask.mockResolvedValue({ status: "succeeded", output: { assets: [{ url: "result.mp4" }] } });
    await page.generate(); await vi.advanceTimersByTimeAsync(0);
    page.storageKey = ""; await page.onShow();
    await page.generate();
    expect(api.generate).toHaveBeenCalledTimes(1);
    expect(page.data.resultUrl).toBe("result.mp4");
  });
  it("does not submit from a destroyed page after conversation creation finishes", async () => {
    let finish!: (value: unknown) => void;
    api.createConversation.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    api.deleteConversation.mockResolvedValue({ ok: true });
    const generation = page.generate(); await vi.advanceTimersByTimeAsync(0);
    page.onUnload(); finish({ id: "conv" }); await generation;
    expect(api.generate).not.toHaveBeenCalled();
    expect(api.deleteConversation).toHaveBeenCalledWith("conv");
  });
  it("allows another paid attempt only after settings change", async () => {
    api.getTask.mockResolvedValue({ status: "succeeded", output: { assets: [{ url: "result.mp4" }] } });
    await page.generate(); await vi.advanceTimersByTimeAsync(0);
    page.field({ currentTarget: { dataset: { field: "publishTitle" } }, detail: { value: "发布标题" } });
    await page.generate(); expect(api.generate).toHaveBeenCalledTimes(1);
    page.field({ currentTarget: { dataset: { field: "script" } }, detail: { value: "另一份分镜" } });
    await page.generate(); expect(api.generate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(wx.showModal).mock.calls[1][0].content).toContain("新的付费生成");
  });
  it("never turns a completed video's download failure into another paid attempt", async () => {
    api.getTask.mockResolvedValue({ status: "succeeded", output: { downloadFailed: true } });
    await page.generate(); await vi.advanceTimersByTimeAsync(0);
    await page.generate();
    expect(api.generate).toHaveBeenCalledTimes(1);
    expect(page.data).toMatchObject({ pending: false, downloadFailed: true, unchanged: true });
  });
  it("keeps a lost submission locked and polling without resubmission", async () => {
    api.generate.mockRejectedValue({ status: 409 });
    api.getConversation.mockResolvedValue({ messages: [] });
    await page.generate(); await page.generate();
    expect(page.data.pending).toBe(true);
    expect(api.generate).toHaveBeenCalledTimes(1);
    expect(api.deleteConversation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("video lost-submission resolution", () => {
  it("adopts a completed generation found on the conversation when the task id was never received", async () => {
    saved["lot:video:owner"] = { conversationId: "conv", pending: true, startedAt: Date.now() };
    api.getConversation.mockResolvedValue({ messages: [{ id: "m", role: "assistant", metadata: { kind: "generation", mediaType: "video", taskId: "task", status: "completed", assets: [{ url: "/static/assets/late.mp4" }] } }] });
    await page.onShow(); await vi.advanceTimersByTimeAsync(0);
    expect(page.data).toMatchObject({ pending: false, resultUrl: "/static/assets/late.mp4" });
    expect(api.getTask).not.toHaveBeenCalled();
  });
  it("unlocks a submission that never reached the server once the grace period is over", async () => {
    saved["lot:video:owner"] = { conversationId: "conv", pending: true, startedAt: Date.now() - 4 * 60_000 };
    api.getConversation.mockResolvedValue({ messages: [] }); api.deleteConversation.mockResolvedValue({ ok: true });
    await page.onShow(); await vi.advanceTimersByTimeAsync(0);
    expect(page.data).toMatchObject({ pending: false, conversationId: "" });
    expect(page.data.status).toContain("未消耗积分");
    expect(api.deleteConversation).toHaveBeenCalledWith("conv");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps waiting inside the grace period and when the conversation cannot be read", async () => {
    saved["lot:video:owner"] = { conversationId: "conv", pending: true, startedAt: Date.now() - 30_000 };
    api.getConversation.mockResolvedValue({ messages: [] });
    await page.onShow(); await vi.advanceTimersByTimeAsync(0);
    expect(page.data.pending).toBe(true); expect(api.deleteConversation).not.toHaveBeenCalled();
    api.getConversation.mockRejectedValue({ status: 0 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(page.data.pending).toBe(true); expect(page.data.status).toContain("暂时无法查询");
  });
});

describe("video waiting controls", () => {
  it("offers to stop waiting only for stale tasks and never cancels the task", async () => {
    saved["lot:video:owner"] = { conversationId: "conv", taskId: "task", pending: true, startedAt: Date.now() - 31 * 60_000 };
    api.getTask.mockResolvedValue({ status: "running", progress: 10 });
    await page.onShow(); await vi.advanceTimersByTimeAsync(0);
    expect(page.data.stale).toBe(true);
    page.stopWaiting();
    expect(page.data).toMatchObject({ pending: false, conversationId: "", taskId: "", locked: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(api.generate).not.toHaveBeenCalled();
  });
  it("is not stale for a fresh task", async () => {
    saved["lot:video:owner"] = { conversationId: "conv", taskId: "task", pending: true, startedAt: Date.now() };
    api.getTask.mockResolvedValue({ status: "running", progress: 10 });
    await page.onShow(); await vi.advanceTimersByTimeAsync(0);
    expect(page.data.stale).toBe(false);
    page.stopWaiting(); expect(page.data.pending).toBe(true);
    expect(vi.mocked(wx.showModal)).not.toHaveBeenCalled();
  });
  it("coalesces keystrokes into one storage write and flushes on hide", async () => {
    await page.onShow(); vi.mocked(wx.setStorageSync).mockClear();
    for (const value of ["咖", "咖啡", "咖啡店"]) page.field({ currentTarget: { dataset: { field: "topic" } }, detail: { value } });
    expect(wx.setStorageSync).not.toHaveBeenCalled();
    page.onHide();
    expect(wx.setStorageSync).toHaveBeenCalledTimes(1);
    expect(saved["lot:video:owner"].draft.topic).toBe("咖啡店");
  });
  it("shows the copy failure inline instead of a truncated toast", async () => {
    await page.onShow(); page.data.draft.topic = "主题";
    api.videoCopy.mockRejectedValue(Object.assign(new Error("secret vendor"), { status: 502 }));
    await page.writeCopy();
    expect(page.data.copyError).toContain("文案生成失败"); expect(page.data.copyError).not.toContain("secret");
    expect(page.data.locked).toBe(false);
  });
  it("points to recharge when the submission is rejected for quota", async () => {
    await page.onShow(); page.data.draft.script = "分镜";
    api.createConversation.mockResolvedValue({ id: "conv" }); api.deleteConversation.mockResolvedValue({ ok: true });
    api.generate.mockRejectedValue(Object.assign(new Error("daily limit"), { status: 402 }));
    vi.stubGlobal("wx", { ...wx, navigateTo: vi.fn() });
    await page.generate();
    expect(page.data).toMatchObject({ pending: false, conversationId: "", status: "账户积分不足，请充值后再试" });
    const modal = vi.mocked(wx.showModal).mock.calls.at(-1)![0];
    expect(modal.title).toBe("积分不足");
    modal.success?.({ confirm: true, cancel: false });
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: "/pages/recharge/index" });
  });
});

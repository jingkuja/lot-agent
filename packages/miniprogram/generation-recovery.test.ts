import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ createConversation: vi.fn(), generate: vi.fn(), getConversation: vi.fn(), getTask: vi.fn(), deleteConversation: vi.fn(), uploadLocalImage: vi.fn() }));
vi.mock("./miniprogram/services/api", () => ({ api, absoluteMedia: (url: string) => url, ApiError: class extends Error {} }));
import { runImageGeneration } from "./miniprogram/services/generate";
const input = { prompt: "图片", size: "1024x1024", quality: "auto" };
beforeEach(() => {
  vi.resetAllMocks();
  api.createConversation.mockResolvedValue({ id: "c1" });
  api.generate.mockRejectedValue(Object.assign(new Error("Bad Gateway"), { status: 502 }));
  api.getConversation.mockResolvedValue({ title: "图片", messages: [
    { id: "m1", role: "assistant", metadata: { kind: "generation", mediaType: "image", taskId: "task1" } },
  ] });
  api.getTask.mockResolvedValue({ status: "succeeded", output: { assets: [{ url: "/static/assets/one.png" }] } });
});
describe("image reference uploads", () => {
  it.each([
    "http://tmp/reference.jpeg",
    "https://tmp/reference.jpeg",
    "http://usr/reference.png",
    "wxfile://tmp_reference.jpeg",
    "/tmp/reference.jpeg",
  ])("uploads local reference %s before submitting generation", async (path) => {
    api.generate.mockResolvedValue({ taskId: "task1", assistantMessage: { id: "m1" } });
    api.uploadLocalImage.mockResolvedValue({ url: "/static/uploads/reference.jpeg" });
    await runImageGeneration({ ...input, localRefs: [path] });
    expect(api.uploadLocalImage).toHaveBeenCalledWith(path);
    expect(api.generate).toHaveBeenCalledWith("c1", expect.objectContaining({
      media: [{ type: "reference_image", url: "/static/uploads/reference.jpeg" }],
    }));
    expect(api.uploadLocalImage.mock.invocationCallOrder[0]).toBeLessThan(api.generate.mock.invocationCallOrder[0]);
  });

  it("reuses already uploaded and remote references", async () => {
    const references = ["/static/uploads/one.png", "https://tmp.example.com/two.png"];
    api.generate.mockResolvedValue({ taskId: "task1", assistantMessage: { id: "m1" } });
    await runImageGeneration({ ...input, localRefs: references });
    expect(api.uploadLocalImage).not.toHaveBeenCalled();
    expect(api.generate).toHaveBeenCalledWith("c1", expect.objectContaining({
      media: references.map((url) => ({ type: "reference_image", url })),
    }));
  });

  it("does not submit generation if a local reference upload fails", async () => {
    api.uploadLocalImage.mockRejectedValue(new Error("upload failed"));
    await expect(runImageGeneration({ ...input, localRefs: ["http://tmp/reference.jpeg"] })).rejects.toThrow("服务暂时不可用");
    expect(api.generate).not.toHaveBeenCalled();
    expect(api.deleteConversation).toHaveBeenCalledWith("c1");
  });
});
describe("uncertain generation submission", () => {
  it("rotates waiting messages at 95% and completes only after the task succeeds", async () => {
    vi.useFakeTimers();
    try {
      api.generate.mockResolvedValue({ taskId: "task1", assistantMessage: { id: "m1" } });
      api.getTask.mockResolvedValue({ status: "running" });
      const onStatus = vi.fn();
      const onTask = vi.fn();
      const result = runImageGeneration({ ...input, onStatus, onTask });
      await vi.advanceTimersByTimeAsync(75000);
      const capped = onStatus.mock.calls.filter(([, progress]) => progress === 95);
      expect(new Set(capped.map(([text]) => text)).size).toBe(3);
      expect(onStatus.mock.calls.every(([, progress]) => progress <= 95)).toBe(true);
      // The gallery's active job must exist before the first progress update.
      expect(onTask.mock.invocationCallOrder[0]).toBeLessThan(onStatus.mock.invocationCallOrder[1]);
      api.getTask.mockResolvedValue({ status: "succeeded", output: { assets: [{ url: "/static/assets/one.png" }] } });
      await vi.advanceTimersByTimeAsync(1200);
      await expect(result).resolves.toMatchObject({ imageUrl: "/static/assets/one.png" });
      expect(onStatus).toHaveBeenLastCalledWith("做好啦", 100);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([502, 504, 0])("recovers a queued task after status %s without another generation or deletion", async (status) => {
    api.generate.mockRejectedValue(Object.assign(new Error("connection lost"), { status }));
    const onTask = vi.fn();
    expect(await runImageGeneration({ ...input, onTask })).toMatchObject({ taskId: "task1", imageUrl: "/static/assets/one.png" });
    expect(onTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task1" }));
    expect(api.generate).toHaveBeenCalledTimes(1);
    expect(api.deleteConversation).not.toHaveBeenCalled();
  });
  it("preserves the conversation when recovery is also unavailable", async () => {
    api.getConversation.mockRejectedValue(new Error("offline"));
    await expect(runImageGeneration(input)).rejects.toThrow("提交结果暂未确认");
    expect(api.deleteConversation).not.toHaveBeenCalled();
    expect(api.generate).toHaveBeenCalledTimes(1);
  });
  it("cleans up a new conversation for a definite validation rejection", async () => {
    api.generate.mockRejectedValue(Object.assign(new Error("bad input"), { status: 400 }));
    await expect(runImageGeneration(input)).rejects.toThrow();
    expect(api.deleteConversation).toHaveBeenCalledWith("c1");
    expect(api.getConversation).not.toHaveBeenCalled();
  });
});

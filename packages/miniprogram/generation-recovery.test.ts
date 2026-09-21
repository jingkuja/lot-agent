import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ createConversation: vi.fn(), generate: vi.fn(), getConversation: vi.fn(), getTask: vi.fn(), deleteConversation: vi.fn() }));
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
describe("uncertain generation submission", () => {
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

import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ createConversation: vi.fn(), generate: vi.fn(), getConversation: vi.fn(), deleteConversation: vi.fn(), uploadLocalImage: vi.fn() }));
vi.mock("./miniprogram/services/api", () => ({ api, absoluteMedia: (s: string) => s }));
import { createVideoDraft, submitVideo, recoverVideoTask, findVideoGeneration, videoResult } from "./miniprogram/services/video";
beforeEach(() => {
  vi.resetAllMocks(); api.createConversation.mockResolvedValue({ id: "video-conv" }); api.deleteConversation.mockResolvedValue({ ok: true });
  api.generate.mockResolvedValue({ taskId: "job1" }); api.uploadLocalImage.mockResolvedValue({ url: "/static/uploads/cover.png" });
});
describe("video task submission", () => {
  it("uses video agent, exact tier model, and cover as first frame", async () => {
    const onConversation = vi.fn();
    expect(await submitVideo({ ...createVideoDraft(), script: "镜头", publishTitle: "开业", tags: "#探店", modelIndex: 2, cover: "cover.png", reference: "reference.png" }, onConversation)).toEqual({ conversationId: "video-conv", taskId: "job1" });
    expect(api.createConversation).toHaveBeenCalledWith(expect.any(String), "video", { copy: "开业", tags: "#探店" });
    expect(api.uploadLocalImage).toHaveBeenCalledTimes(1);
    expect(api.uploadLocalImage).toHaveBeenCalledWith("cover.png");
    expect(api.generate).toHaveBeenCalledWith("video-conv", expect.objectContaining({ mediaType: "video", model: "doubao-seedance-2-0-fast", settings: expect.objectContaining({ resolution: "480p" }), first_frame: "/static/uploads/cover.png" }));
    expect(onConversation).toHaveBeenCalledWith("video-conv");
  });
  it("recovers only this video's task after an uncertain response without resubmitting", async () => {
    api.generate.mockRejectedValue({ status: 502 });
    api.getConversation.mockResolvedValue({ messages: [
      { role: "assistant", metadata: { kind: "generation", mediaType: "video", taskId: "job2" } },
      { role: "assistant", metadata: { kind: "generation", mediaType: "image", taskId: "image-job" } },
    ] });
    expect((await submitVideo(createVideoDraft(), vi.fn())).taskId).toBe("job2");
    expect(api.generate).toHaveBeenCalledTimes(1); expect(api.deleteConversation).not.toHaveBeenCalled();
  });
  it("preserves uncertain submissions when recovery is also unavailable", async () => {
    api.generate.mockRejectedValue({ status: 0 }); api.getConversation.mockRejectedValue(new Error("offline"));
    await expect(submitVideo(createVideoDraft(), vi.fn())).rejects.toThrow("勿重复生成");
    expect(api.deleteConversation).not.toHaveBeenCalled();
  });
  it.each([400, 401, 402, 403, 422, 429])("cleans up definitively rejected submissions (%s)", async (status) => {
    api.generate.mockRejectedValue({ status });
    await expect(submitVideo(createVideoDraft(), vi.fn())).rejects.toEqual({ status });
    expect(api.deleteConversation).toHaveBeenCalledWith("video-conv");
  });
  it("keeps an upload failure from leaving a pending paid submission", async () => {
    api.uploadLocalImage.mockRejectedValue(new Error("upload")); const onConversation = vi.fn();
    await expect(submitVideo({ ...createVideoDraft(), reference: "local" }, onConversation)).rejects.toThrow("upload");
    expect(onConversation).not.toHaveBeenCalled(); expect(api.generate).not.toHaveBeenCalled(); expect(api.deleteConversation).toHaveBeenCalled();
  });
  it("ignores malformed metadata and does not expose failed downloads", async () => {
    api.getConversation.mockResolvedValue({ messages: [{ role: "assistant", metadata: "bad json" }] });
    expect(await recoverVideoTask("video-conv")).toBeNull();
    expect(videoResult({ id: "job", progress: 100, status: "succeeded", output: { downloadFailed: true, assets: [{ url: "vendor-video", mime: "video/mp4" }] } })).toBe("");
  });
  it("reads a finished generation from the conversation when the task id was never received", async () => {
    api.getConversation.mockResolvedValue({ messages: [
      { id: "m1", role: "user", content: "prompt" },
      { id: "m2", role: "assistant", status: "completed", metadata: JSON.stringify({ kind: "generation", mediaType: "video", taskId: "job3", status: "completed", assets: [{ url: "/static/assets/v.mp4" }] }) },
    ] });
    expect(await findVideoGeneration("video-conv")).toEqual({ messageId: "m2", taskId: "job3", status: "completed", url: "/static/assets/v.mp4", downloadFailed: false });
  });
  it("reports a download failure and a missing conversation distinctly", async () => {
    api.getConversation.mockResolvedValue({ messages: [{ id: "m2", role: "assistant", metadata: { kind: "generation", mediaType: "video", taskId: "job3", status: "download_failed", sourceUrl: "vendor" } }] });
    expect(await findVideoGeneration("video-conv")).toMatchObject({ downloadFailed: true, url: "" });
    api.getConversation.mockRejectedValue({ status: 404 });
    expect(await findVideoGeneration("gone")).toBeNull();
    api.getConversation.mockRejectedValue({ status: 0 });
    await expect(findVideoGeneration("offline")).rejects.toEqual({ status: 0 });
  });
});

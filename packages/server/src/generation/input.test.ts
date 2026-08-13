import { describe, it, expect } from "vitest";
import { pickGenerationSettings, pickVideoReferenceInputs } from "./input.js";

describe("pickGenerationSettings", () => {
  it("keeps only the image whitelist (size, n) with matching types", () => {
    expect(
      pickGenerationSettings("image", {
        size: "1024x1024",
        n: 2,
        durationSec: 5, // video-only — dropped for image
        extra: "x",
      })
    ).toEqual({ size: "1024x1024", n: 2 });
  });

  it("keeps the video whitelist (size, durationSec, ratio)", () => {
    expect(
      pickGenerationSettings("video", {
        durationSec: 5,
        ratio: "16:9",
        size: "720x1280", // required by the openai-video endpoint
        n: 3, // image-only — dropped for video
      })
    ).toEqual({ size: "720x1280", durationSec: 5, ratio: "16:9" });
  });

  it("drops server identity fields no matter what the client sends", () => {
    expect(
      pickGenerationSettings("image", {
        n: 1,
        assistantMessageId: "victim-message",
        conversationId: "victim-conversation",
        userId: "victim-user",
        taskId: "victim-task",
      })
    ).toEqual({ n: 1 });
  });

  it("drops whitelisted keys carrying the wrong type", () => {
    expect(
      pickGenerationSettings("image", { size: 123, n: "two" })
    ).toEqual({});
  });

  it("handles a missing settings object", () => {
    expect(pickGenerationSettings("video", undefined)).toEqual({});
  });

  it("keeps video references and frame fields with their API shape", () => {
    expect(pickVideoReferenceInputs({
      input_reference: ["a", "b"],
      reference_video: "v",
      reference_audio: ["a1", "a2"],
      first_frame: "first",
      last_frame: "last",
      assistantMessageId: "forged",
    })).toEqual({
      input_reference: ["a", "b"],
      reference_video: "v",
      reference_audio: ["a1", "a2"],
      first_frame: "first",
      last_frame: "last",
    });
  });

  it("enforces the product limits for video references", () => {
    expect(() => pickVideoReferenceInputs({ input_reference: ["1", "2", "3", "4", "5", "6"] })).toThrow(/at most 5/);
    expect(() => pickVideoReferenceInputs({ reference_video: ["1", "2", "3"] })).toThrow(/at most 2/);
    expect(() => pickVideoReferenceInputs({ reference_audio: ["1", "2", "3"] })).toThrow(/at most 2/);
  });
});

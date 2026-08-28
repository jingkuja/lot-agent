import { describe, expect, it } from "vitest";
import {
  KLING_VIDEO_QUALITIES,
  VIDEO_QUALITIES,
  pickVideoQuality,
  videoQualitiesForModel,
} from "./video-settings.js";

describe("videoQualitiesForModel", () => {
  it("uses 720p / 1080p / 4k for Kling ids", () => {
    expect(videoQualitiesForModel("kling-video-v3-omni").map((q) => q.short)).toEqual([
      "720p",
      "1080p",
      "4k",
    ]);
    expect(videoQualitiesForModel("Kling-standard")).toBe(KLING_VIDEO_QUALITIES);
  });

  it("keeps the default 480p ladder for other models", () => {
    expect(videoQualitiesForModel("doubao-seedance-2.0")).toBe(VIDEO_QUALITIES);
    expect(videoQualitiesForModel(null).map((q) => q.short)).toEqual(["480p", "720p", "1080p"]);
  });
});

describe("pickVideoQuality", () => {
  it("keeps a step that is still on the ladder", () => {
    expect(pickVideoQuality(KLING_VIDEO_QUALITIES, "1080p").short).toBe("1080p");
  });

  it("maps 480p onto Kling 720p and 4k onto the default 1080p", () => {
    expect(pickVideoQuality(KLING_VIDEO_QUALITIES, "480p").short).toBe("720p");
    expect(pickVideoQuality(VIDEO_QUALITIES, "4k").short).toBe("1080p");
  });
});

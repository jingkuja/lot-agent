import { describe, expect, it } from "vitest";
import {
  H3_MAX_VIDEO_QUALITIES,
  KLING_VIDEO_QUALITIES,
  MINIMAX_H3_VIDEO_QUALITIES,
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

  it("uses 768p / 2k for MiniMax H3 ids", () => {
    expect(videoQualitiesForModel("minimax-video-h3").map((q) => q.short)).toEqual(["768p", "2k"]);
    expect(videoQualitiesForModel("MiniMax-H3")).toBe(MINIMAX_H3_VIDEO_QUALITIES);
  });

  it("uses 480p / 768p for H3 Max ids", () => {
    expect(videoQualitiesForModel("h3-max").map((q) => q.short)).toEqual(["480p", "768p"]);
    expect(videoQualitiesForModel("minimax-video-h3-max")).toBe(H3_MAX_VIDEO_QUALITIES);
  });

  it("keeps the default 480p ladder for other models", () => {
    expect(videoQualitiesForModel("doubao-seedance-2.0")).toBe(VIDEO_QUALITIES);
    expect(videoQualitiesForModel(null).map((q) => q.short)).toEqual(["480p", "720p", "1080p"]);
  });
});

describe("pickVideoQuality", () => {
  it("keeps a step that is still on the ladder", () => {
    expect(pickVideoQuality(KLING_VIDEO_QUALITIES, "1080p").short).toBe("1080p");
    expect(pickVideoQuality(MINIMAX_H3_VIDEO_QUALITIES, "768p").short).toBe("768p");
    expect(pickVideoQuality(H3_MAX_VIDEO_QUALITIES, "480p").short).toBe("480p");
  });

  it("maps 480p onto Kling 720p and 4k onto the default 1080p", () => {
    expect(pickVideoQuality(KLING_VIDEO_QUALITIES, "480p").short).toBe("720p");
    expect(pickVideoQuality(VIDEO_QUALITIES, "4k").short).toBe("1080p");
  });

  it("maps neighbouring ladders onto MiniMax H3 and H3 Max", () => {
    expect(pickVideoQuality(MINIMAX_H3_VIDEO_QUALITIES, "480p").short).toBe("768p");
    expect(pickVideoQuality(MINIMAX_H3_VIDEO_QUALITIES, "1080p").short).toBe("768p");
    expect(pickVideoQuality(MINIMAX_H3_VIDEO_QUALITIES, "4k").short).toBe("2k");
    expect(pickVideoQuality(H3_MAX_VIDEO_QUALITIES, "720p").short).toBe("768p");
    expect(pickVideoQuality(H3_MAX_VIDEO_QUALITIES, "2k").short).toBe("768p");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildComicGenerationInput, comicFrozenGenerationSchema, comicGenerationPreviewSchema, comicTimelineSchema, layoutComicTimeline,
  type ComicCastSnapshot, type ComicDramaClip, type ComicDramaSeries, type ComicFrozenGenerationInput, type ComicSeriesCast,
} from "./index.js";
import { FakeComicGenerationProvider } from "./generation-fixture.js";

const uuid = (n: number) => `abcdef01-2345-4567-8abc-${String(n).padStart(12, "0")}`;
const series: ComicDramaSeries = {
  id: uuid(1), title: "雨夜便利店", parentId: null, logline: "", seriesGroup: null, episodeNo: null,
  styleKey: "thick_painting", videoModel: "grok-imagine-video-1.5", aspectRatio: "9:16", revision: 4, archivedAt: null,
};
const snapshot: ComicCastSnapshot = {
  schemaVersion: 1, characterId: uuid(2), name: "Lin", aliases: [], age: "", personality: "", appearance: "short hair",
  roleKey: "lead", outfitId: uuid(3), outfitName: "Raincoat",
  assets: [
    { kind: "slot", key: "front", version: 1, media: image(4) },
    { kind: "expression", key: "smile", version: 3, media: image(5) },
  ],
};
function image(n: number) {
  return { id: uuid(n), mime: "image/png" as const, sizeBytes: 4096, width: 720, height: 1280, durationMs: null, hasThumbnail: true };
}
const cast: ComicSeriesCast[] = [{ snapshot, archived: false, hasUpdates: true }];
const clip: ComicDramaClip = {
  id: uuid(6), ordinal: 1, revision: 7,
  draft: {
    schemaVersion: 1, durationMs: 8000, scene: "柜台", lines: [],
    shots: [{ id: uuid(7), description: "Lin enters the shop.", framingKey: "wide", movementKey: "fixed", durationShare: 100 }],
    cast: [{ characterId: snapshot.characterId, slotKey: "front", expressionKey: "smile" }],
  },
};
const base = { series, clip, cast, modelId: series.videoModel! };
const keyframe = { ...image(8), mediaId: uuid(8), takeId: uuid(9), version: 2 };
const freeze = (result: ReturnType<typeof buildComicGenerationInput>): ComicFrozenGenerationInput => {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.input;
};

describe("comic generation contracts", () => {
  it("binds media versions from the episode snapshot in provider order, even when the library has updates", () => {
    const scene = { ...image(10), mediaId: uuid(10), version: 1, kind: "scene" as const, label: "shop interior" };
    const result = freeze(buildComicGenerationInput({ ...base, mode: "from_keyframe", firstFrame: { ...keyframe, url: "https://fixture.invalid/signed" } as typeof keyframe, visualReferences: [scene] }));
    expect(result.references.map(ref => [ref.mediaId, ref.version])).toEqual([[uuid(4), 1], [uuid(5), 3], [uuid(10), 1]]);
    expect(result.firstFrame?.takeId).toBe(uuid(9));
    expect(result.prompt).toContain("<IMAGE_0> is Lin's appearance");
    expect(result.prompt).toContain("<IMAGE_2> is the scene reference: shop interior");
    expect(result.seriesRevision).toBe(4);
    expect(result.clipRevision).toBe(7);
    expect(JSON.stringify(result)).not.toContain("http");
    expect(comicFrozenGenerationSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it("keeps review mode gated and rejects missing or unsupported references", () => {
    expect(buildComicGenerationInput({ ...base, mode: "from_keyframe" })).toMatchObject({
      ok: false, issues: [{ code: "KEYFRAME_NOT_CONFIRMED" }],
    });
    const visualReferences = Array.from({ length: 6 }, (_, i) =>
      ({ ...image(i + 20), mediaId: uuid(i + 20), version: 1, kind: "prop" as const, label: "prop" }));
    expect(buildComicGenerationInput({ ...base, mode: "references", modelId: "kling-video-v3-omni", visualReferences })).toMatchObject({
      ok: false, issues: [{ code: "REFERENCE_LIMIT" }],
    });
    expect(buildComicGenerationInput({ ...base, mode: "keyframe", cast: [] })).toMatchObject({
      ok: false, issues: [{ code: "CAST_REFERENCE_MISSING" }],
    });
    const target = { clipId: clip.id, expectedRevision: clip.revision };
    expect(comicGenerationPreviewSchema.safeParse({ mode: "keyframe", expectedSeriesRevision: 4, targets: [target, target] }).success).toBe(false);
  });

  it("supports a no-network first-frame receipt and distinguishes rejected and unknown submissions", async () => {
    const frozen = freeze(buildComicGenerationInput({ ...base, mode: "keyframe", modelId: "fixture-image" }));
    const taskId = "fixture-frame";
    const provider = new FakeComicGenerationProvider({ state: "accepted", providerTaskId: taskId }, [
      { state: "processing" }, { state: "completed", outputUrl: "https://fixture.invalid/frame.png" },
    ]);
    expect(await provider.submit(frozen)).toMatchObject({ state: "accepted", providerTaskId: taskId });
    expect(await provider.poll(taskId)).toEqual({ state: "processing" });
    expect(await provider.poll(taskId)).toMatchObject({ state: "completed" });
    expect(provider.submissions).toEqual([frozen]);
    for (const state of ["rejected", "unknown"] as const) {
      const failed = new FakeComicGenerationProvider({ state, code: "FIXTURE" });
      expect(await failed.submit(frozen)).toMatchObject({ state });
      await expect(failed.poll(taskId)).rejects.toThrow("Unknown fixture task");
    }
  });
});

describe("comic timeline contract", () => {
  const data = {
    schemaVersion: 1, aspectRatio: "9:16", voice: [], sfx: [], music: [], subtitles: [],
    video: [
      { id: uuid(50), takeId: uuid(51), sourceDurationMs: 6000, inMs: 0, outMs: 6000, volume: 1, transitionIn: { kind: "cut", durationMs: 0 } },
      { id: uuid(52), takeId: uuid(53), sourceDurationMs: 8000, inMs: 400, outMs: 7600, volume: 1, transitionIn: { kind: "cut", durationMs: 0 } },
    ],
  };

  it("uses immutable take IDs, integer trims and deterministic overlapping durations", () => {
    const straight = comicTimelineSchema.parse(data);
    expect(layoutComicTimeline(straight).durationMs).toBe(13_200);
    const faded = comicTimelineSchema.parse({ ...data, video: [data.video[0],
      { ...data.video[1], transitionIn: { kind: "crossfade", durationMs: 500 } }] });
    expect(layoutComicTimeline(faded)).toMatchObject({ durationMs: 12_700 });
    expect(layoutComicTimeline(faded).video[1]).toEqual({ id: uuid(52), startMs: 5500, endMs: 12_700 });
    expect(faded.video[1].takeId).toBe(uuid(53));
  });

  it("moves clip-anchored subtitles with their clip and keeps absolute music positions", () => {
    const music = { id: uuid(60), mediaId: uuid(61), anchor: { kind: "timeline", offsetMs: 500 }, durationMs: 1200,
      sourceInMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false };
    const subtitles = [{ id: uuid(62), anchor: { kind: "clip", videoItemId: uuid(52), offsetMs: 300 }, durationMs: 800, text: "柜台相遇" }];
    const original = layoutComicTimeline(comicTimelineSchema.parse({ ...data, music: [music], subtitles }));
    const moved = layoutComicTimeline(comicTimelineSchema.parse({ ...data, video: [...data.video].reverse(), music: [music], subtitles }));
    expect([original.subtitles[0].startMs, moved.subtitles[0].startMs]).toEqual([6300, 300]);
    expect(moved.music).toEqual(original.music);
  });

  it("rejects clips beyond source length and missing anchor targets", () => {
    expect(comicTimelineSchema.safeParse({ ...data, video: [{ ...data.video[0], outMs: 6001 }] }).success).toBe(false);
    expect(comicTimelineSchema.safeParse({ ...data, subtitles: [{
      id: uuid(55), anchor: { kind: "clip", videoItemId: uuid(56), offsetMs: 0 }, durationMs: 1000, text: "test",
    }] }).success).toBe(false);
  });
});

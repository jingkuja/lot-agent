import { describe, expect, it } from "vitest";
import {
  buildComicGenerationInput, checkComicClipIssues, checkComicSeriesIssues, COMIC_SPEECH_PRESET_CATALOG, comicDirectorChatInputSchema,
  comicDramaClipDraftSchema, comicFrozenGenerationSchema, comicGenerationPreviewSchema, comicImageOptions, comicRenderIssue, comicSpeechReleaseSchema,
  comicTimelineSchema, comicVoiceAuditionReleaseSchema, comicVoiceAuditionSchema, estimateComicDialogueMs, layoutComicTimeline,
  comicUserPreferencesSchema, comicVideoOptions, comicVideoProfile, matchComicCharacters, planClipSfxPlacements, selectComicImageModel,
  type ComicCastSnapshot, type ComicDramaClip, type ComicDramaSeries, type ComicFrozenGenerationInput, type ComicSeriesCast,
} from "./index.js";
import { FakeComicGenerationProvider } from "./generation-fixture.js";

const uuid = (n: number) => `abcdef01-2345-4567-8abc-${String(n).padStart(12, "0")}`;
const series: ComicDramaSeries = {
  id: uuid(1), title: "雨夜便利店", parentId: null, logline: "", seriesGroup: null, episodeNo: null,
  styleKey: "thick_painting", videoModel: "doubao-seedance-2-5", aspectRatio: "9:16", revision: 4, archivedAt: null,
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
  id: uuid(6), ordinal: 1, revision: 7, selectionRevision: 1,
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
  it("uses the account catalog for image tiers and the three standard video choices", () => {
    const catalog = (...ids: string[]) => ids.map(id => ({ id }));
    const images = catalog("gpt-image-2", "lingqu-image", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "linqu-image");
    expect(comicImageOptions(images).map(model => [model.id, model.label])).toEqual([
      ["gpt-image-2.5-flare", "默认"], ["gpt-image-2.5-sunburst", "旗舰"], ["linqu-image", "无限制出图"],
    ]);
    expect(selectComicImageModel(images, "gpt-image-2")).toBe("gpt-image-2.5-flare");
    expect(selectComicImageModel(images, "lingqu-image")).toBe("linqu-image");
    expect(selectComicImageModel(catalog("gpt-image-2"))).toBeNull();
    const videos = catalog("grok-imagine-video-1.5", "doubao-seedance-2-5-flash-261115", "doubao-seedance-2-0-fast-260128",
      "minimax-video-h3-max", "minimax-video-h3", "doubao-seedance-2-0-260128", "doubao-seedance-2-5");
    expect(comicVideoOptions(videos).map(model => model.id)).toEqual(["doubao-seedance-2-5", "doubao-seedance-2-0-260128", "minimax-video-h3"]);
    expect(comicVideoProfile("MiniMax-H3")?.promptMaxChars).toBe(7000);
    expect(comicVideoProfile("kling-video-v3-omni")).toBeUndefined();
    expect(comicUserPreferencesSchema.parse({ defaultImageModel: "gpt-image-2.5-flare", defaultTextModel: "legacy" })).toEqual({
      defaultImageModel: "gpt-image-2.5-flare",
    });
  });

  it("freezes model-specific video settings and separates strict first frames from references", () => {
    const h3 = freeze(buildComicGenerationInput({ ...base, modelId: "minimax-video-h3", mode: "from_keyframe", firstFrame: keyframe }));
    expect(h3).toMatchObject({ resolution: "768P", firstFrame: { mediaId: keyframe.mediaId }, references: [] });
    expect(h3.prompt).toContain("short hair");
    expect(comicFrozenGenerationSchema.parse(h3)).toEqual(h3);
    const seedance = { ...base, modelId: "doubao-seedance-2-5", mode: "references" as const };
    const visualReferences = Array.from({ length: 28 }, (_, i) =>
      ({ ...image(i + 20), mediaId: uuid(i + 20), version: 1, kind: "prop" as const, label: "prop" }));
    const longClip = { ...clip, draft: { ...clip.draft, durationMs: 30_000 } };
    const video = freeze(buildComicGenerationInput({ ...seedance, clip: longClip, visualReferences }));
    expect(video).toMatchObject({ durationMs: 30_000, resolution: "720p", firstFrame: null });
    expect(video.references).toHaveLength(30);
    expect(video.prompt).toContain("@Image30");
    const excess = buildComicGenerationInput({ ...seedance, clip: longClip, visualReferences: [...visualReferences, visualReferences[0]] });
    expect(excess).toMatchObject({ ok: false, issues: [{ code: "REFERENCE_LIMIT" }] });
    expect(buildComicGenerationInput({ ...seedance, modelId: "doubao-seedance-2-0", clip: longClip })).toMatchObject({
      ok: false, issues: [{ code: "DURATION_UNSUPPORTED" }],
    });
    expect(buildComicGenerationInput({ ...seedance, clip: { ...clip, draft: { ...clip.draft, scene: "Use @Audio1" } } })).toMatchObject({
      ok: false, issues: [{ code: "PROMPT_REFERENCE_UNBOUND" }],
    });
  });
  it("binds media versions from the episode snapshot in provider order, even when the library has updates", () => {
    const scene = { ...image(10), mediaId: uuid(10), version: 1, kind: "scene" as const, label: "shop interior" };
    const result = freeze(buildComicGenerationInput({ ...base, mode: "references", visualReferences: [scene] }));
    expect(result.references.map(ref => [ref.mediaId, ref.version])).toEqual([[uuid(4), 1], [uuid(5), 3], [uuid(10), 1]]);
    expect(result.firstFrame).toBeNull();
    expect(result.prompt).toContain("@Image1 is Lin's appearance");
    expect(result.prompt).toContain("@Image3 is the scene reference: shop interior");
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
    expect(buildComicGenerationInput({ ...base, mode: "references", modelId: "doubao-seedance-2-0",
      visualReferences: [...visualReferences, ...visualReferences.slice(0, 4)] })).toMatchObject({
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

  it("allows 40-clip full episodes with 80+ audio lines and enforces per-kind ceilings", () => {
    const video = Array.from({ length: 40 }, (_, i) => ({
      id: uuid(100 + i), takeId: uuid(200 + i), sourceDurationMs: 6000, inMs: 0, outMs: 6000,
      volume: 1, transitionIn: { kind: "cut" as const, durationMs: 0 as const },
    }));
    const voice = video.flatMap((clip, i) => [0, 1].map(slot => ({
      id: uuid(300 + i * 2 + slot), mediaId: uuid(500 + i * 2 + slot),
      anchor: { kind: "clip" as const, videoItemId: clip.id, offsetMs: slot * 2000 },
      durationMs: 1500, sourceInMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false,
    })));
    const music = [{
      id: uuid(900), mediaId: uuid(901), anchor: { kind: "timeline" as const, offsetMs: 0 },
      durationMs: 240_000, sourceInMs: 0, volume: 0.3, fadeInMs: 0, fadeOutMs: 0, loop: true,
    }];
    const sfx = Array.from({ length: 10 }, (_, i) => ({
      id: uuid(910 + i), mediaId: uuid(950 + i), anchor: { kind: "timeline" as const, offsetMs: i * 1000 },
      durationMs: 500, sourceInMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false,
    }));
    expect(comicRenderIssue(comicTimelineSchema.parse({
      schemaVersion: 1, aspectRatio: "9:16", video, voice, music, sfx, subtitles: [],
    }))).toBeNull();

    const tooManyVideos = Array.from({ length: 61 }, (_, i) => ({
      id: uuid(1000 + i), takeId: uuid(1100 + i), sourceDurationMs: 4000, inMs: 0, outMs: 4000,
      volume: 1, transitionIn: { kind: "cut" as const, durationMs: 0 as const },
    }));
    expect(comicRenderIssue(comicTimelineSchema.parse({
      schemaVersion: 1, aspectRatio: "9:16", video: tooManyVideos, voice: [], music: [], sfx: [], subtitles: [],
    }))).toBe("RENDER_LIMIT");

    const tooManyAudio = Array.from({ length: 241 }, (_, i) => ({
      id: uuid(2000 + i), mediaId: uuid(2500 + i), anchor: { kind: "timeline" as const, offsetMs: 0 },
      durationMs: 500, sourceInMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false,
    }));
    expect(comicRenderIssue(comicTimelineSchema.parse({
      schemaVersion: 1, aspectRatio: "9:16", video: [video[0]], voice: tooManyAudio, music: [], sfx: [], subtitles: [],
    }))).toBe("RENDER_LIMIT");

    expect(comicSpeechReleaseSchema.safeParse({
      expectedRevision: 1, expectedClipRevision: 1, voice: { kind: "preset", preset: "alloy" }, acknowledgePossibleCharge: true,
    }).success).toBe(true);
    expect(comicSpeechReleaseSchema.safeParse({
      expectedRevision: 1, expectedClipRevision: 1, voice: { kind: "preset", preset: "alloy" }, acknowledgePossibleCharge: false,
    }).success).toBe(false);
  });
});

describe("comic v1 quality checks, refs, presets and schemas", () => {
  it("detects all 4 product-spec §4.2/§5.3 clip issues", () => {
    const denseClip: ComicDramaClip = {
      id: uuid(70), ordinal: 2, revision: 1, selectionRevision: 1,
      draft: comicDramaClipDraftSchema.parse({
        schemaVersion: 1, durationMs: 4000, scene: "便利店门口",
        shots: [{ id: uuid(71), framingKey: "wide", movementKey: "fixed", description: "Rainy street.", durationShare: 100 }],
        lines: [
          {
            id: uuid(72), speaker: "陌生人", emotionKey: null, speed: 1,
            text: "这是一段非常长非常长非常长非常长非常长非常长非常长的台词，明显会超过四秒钟的成片时长限制。",
          },
        ],
        cast: [{ characterId: snapshot.characterId, slotKey: "front", expressionKey: "smile" }],
        sceneRef: { materialId: uuid(73), mediaId: uuid(74), name: "雨夜街道" },
        propRefs: Array.from({ length: 6 }, (_, i) => ({ materialId: uuid(80 + i), mediaId: uuid(90 + i) })),
        sfxRefs: [{ materialId: uuid(99), mediaId: uuid(98), name: "雨声" }],
      }),
    };
    const seedanceSeries = { ...series, videoModel: "doubao-seedance-2-0" };
    const issues = checkComicSeriesIssues({ series: seedanceSeries, clips: [denseClip], cast }, { hasStyleRef: true });
    expect(issues.map(issue => issue.code)).toEqual([
      "SPEAKER_NOT_IN_CAST",
      "REFERENCE_LIMIT_EXCEEDED",
      "DIALOGUE_TOO_LONG",
      "CAST_UPDATED_IN_LIBRARY",
    ]);
    expect(estimateComicDialogueMs(denseClip.draft.lines)).toBeGreaterThan(4000);
    expect(checkComicClipIssues(series, clip, [{ ...cast[0], hasUpdates: false }])).toEqual([]);
  });

  it("supports loose alias matching, trilingual speech presets, audition and director chat schemas", () => {
    const matched = matchComicCharacters("小 夏！", [
      { id: uuid(1), name: "林夏", aliases: ["小夏", "Lin"] },
      { id: uuid(2), name: "陈墨", aliases: ["阿墨"] },
    ]);
    expect(matched.map(item => item.id)).toEqual([uuid(1)]);
    expect(COMIC_SPEECH_PRESET_CATALOG.every(item => item.labels.zh && item.labels.en && item.labels.id)).toBe(true);
    expect(comicVoiceAuditionSchema.safeParse({
      text: "雨停之前别走。", speed: 1.1, emotionKey: "gentle", voice: { kind: "preset", preset: "nova" },
    }).success).toBe(true);
    expect(comicDirectorChatInputSchema.safeParse({
      message: "帮我检查全集有没有漏选角", expectedRevision: 3, language: "zh",
    }).success).toBe(true);
    expect(comicVoiceAuditionReleaseSchema.safeParse({
      text: "雨停之前别走。", speed: 1, emotionKey: null, voice: { kind: "preset", preset: "nova" }, acknowledgePossibleCharge: true,
    }).success).toBe(true);
  });

  it("P1 #4 & P2 #8: surfaces invalid material refs and plans per-shot + legacy SFX placements that stay synced on reorder", () => {
    const clipWithInvalidMat: ComicDramaClip = {
      ...clip,
      progress: {
        keyframeState: "none", keyframeMediaId: null, keyframeApproved: false, keyframeStale: false,
        videoState: "none", videoTakeCount: 0, adoptedVideoTakeId: null, adoptedVideoVersion: null,
        adoptedVideoMediaId: null, adoptedStale: false, castSnapshotStale: false,
        invalidMaterialRefs: [{ role: "prop", materialId: uuid(50), mediaId: uuid(51), name: "旧道具", reason: "ARCHIVED" }],
      },
    };
    const issues = checkComicClipIssues(series, clipWithInvalidMat, [{ ...cast[0], hasUpdates: false }]);
    expect(issues.some(issue => issue.code === "INVALID_MATERIAL_REFERENCE" && issue.reason === "ARCHIVED")).toBe(true);

    const draft = comicDramaClipDraftSchema.parse({
      schemaVersion: 1, durationMs: 8000, scene: "双镜头",
      shots: [
        {
          id: uuid(61), framingKey: "wide", movementKey: "fixed", description: "镜头1", durationShare: 50,
          sfxRefs: [{ materialId: uuid(71), mediaId: uuid(81), name: "门铃", position: "start" }],
        },
        {
          id: uuid(62), framingKey: "close_up", movementKey: "push", description: "镜头2", durationShare: 50,
          sfxRefs: [{ materialId: uuid(72), mediaId: uuid(82), name: "闪电", position: "end" }],
        },
      ],
      lines: [],
      sfxRefs: [{ materialId: uuid(73), mediaId: uuid(83), name: "旧雨声" }],
    });
    let seq = 900;
    const videoId = uuid(600);
    const otherVideoId = uuid(601);
    const sfx = planClipSfxPlacements(
      draft,
      videoId,
      8000,
      new Map([[uuid(81), 1000], [uuid(82), 1200], [uuid(83), 5000]]),
      () => uuid(++seq),
    );
    expect(sfx).toHaveLength(3);
    expect(sfx.map(item => [item.mediaId, item.anchor.offsetMs, item.durationMs])).toEqual([
      [uuid(81), 0, 1000],
      [uuid(82), 6800, 1200],
      [uuid(83), 0, 5000],
    ]);

    const reordered = comicTimelineSchema.parse({
      schemaVersion: 1, aspectRatio: "9:16",
      video: [
        { id: otherVideoId, takeId: uuid(610), sourceDurationMs: 4000, inMs: 0, outMs: 4000, volume: 1, transitionIn: { kind: "cut", durationMs: 0 } },
        { id: videoId, takeId: uuid(611), sourceDurationMs: 8000, inMs: 0, outMs: 8000, volume: 1, transitionIn: { kind: "cut", durationMs: 0 } },
      ],
      voice: [], sfx, music: [], subtitles: [],
    });
    const layout = layoutComicTimeline(reordered);
    expect(layout.sfx.map(item => item.startMs)).toEqual([4000, 10800, 4000]);
  });
});

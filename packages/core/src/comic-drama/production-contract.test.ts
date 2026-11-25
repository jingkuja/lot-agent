import { describe, expect, it } from "vitest";
import {
  adaptComicClipDraftForModel, analyzeComicModelSwitch, applyComicScriptEnhancements, buildComicDramaHierarchy,
  buildComicGenerationInput, checkComicClipIssues, checkComicSeriesIssues,
  COMIC_SPEECH_PRESET_CATALOG, comicDirectorApplySchema, comicDirectorChatInputSchema, comicDirectorDismissSchema, comicDirectorInputSchema,
  comicDramaClipDraftSchema, comicDramaSchema, comicDramaSeriesSchema, comicFrozenGenerationSchema, comicGenerationPreviewSchema, comicImageOptions,
  comicRenderDurationToleranceMs, comicRenderIssue, comicSpeechReleaseSchema, comicTimelineSchema, comicUserPreferencesSchema, comicVideoOptions,
  comicVideoProfile, comicVoiceAuditionReleaseSchema, comicVoiceAuditionSchema, countComicClipFoldedReferences, countComicClipReferences,
  createComicDramaSchema, estimateComicDialogueMs, extractComicScriptExcerptSegments,
  layoutComicTimeline, mapComicVideoResolution, matchComicCharacters, normalizeShotDurationShares, planClipSfxPlacements,
  rebalanceShotDurationShares, resolveComicRenderFps, resolveComicVideoAudioMode, selectComicImageModel,
  selectComicVideoModel, splitComicScriptSegments, validateComicVideoInput, type ComicGenerationTimedMedia, type ComicCastSnapshot,
  type ComicDramaClip, type ComicDramaSeries, type ComicFrozenGenerationInput, type ComicSeriesCast,
} from "./index.js";
import { FakeComicGenerationProvider } from "./generation-fixture.js";

const uuid = (n: number) => `abcdef01-2345-4567-8abc-${String(n).padStart(12, "0")}`;
const series: ComicDramaSeries = {
  id: uuid(1), dramaId: uuid(99), title: "雨夜便利店", parentId: null, logline: "", seriesGroup: null, episodeNo: null,
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
    expect(comicVideoOptions(videos)[0]?.label).toBe("Seedance 2.5");
    expect(selectComicVideoModel(videos)).toBe("doubao-seedance-2-0-260128");
    expect(selectComicVideoModel(videos, "minimax-video-h3")).toBe("minimax-video-h3");
    expect(selectComicVideoModel(videos, "grok-imagine-video-1.5")).toBe("doubao-seedance-2-0-260128");
    expect(selectComicVideoModel(catalog("doubao-seedance-2-5"))).toBe("doubao-seedance-2-5");
    expect(comicVideoProfile("MiniMax/MiniMax-H3")?.promptMaxChars).toBe(7000);
    expect(comicVideoProfile("MiniMax-H3")?.promptLimitUnverified).toBe(true);
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
  const audio = (n: number, durationMs = 4000): Extract<ComicGenerationTimedMedia, { kind: "audio" }> => ({
    kind: "audio", mime: "audio/wav", mediaId: uuid(n), version: 2, label: "voice",
    sizeBytes: 120_000, durationMs, audioCodec: "pcm_s16le", channels: 1, sampleRate: 16000,
  });
  const video = (n: number, durationMs = 4000): Extract<ComicGenerationTimedMedia, { kind: "video" }> => ({
    kind: "video", mime: "video/mp4", mediaId: uuid(n), version: 1, label: "motion",
    sizeBytes: 800_000, durationMs, width: 720, height: 1280, fps: 24, videoCodec: "h264", audioCodec: null,
  });

  it("checks the H3 shared limit and the BaiLian final prompt limit independently", () => {
    const input = freeze(buildComicGenerationInput({
      ...base, mode: "references", modelId: "MiniMax/MiniMax-H3",
      visualReferences: Array.from({ length: 7 }, (_, i) =>
        ({ ...image(20 + i), mediaId: uuid(20 + i), kind: "image", label: "setting", version: 1 })),
      timedReferences: [audio(40), audio(41), video(42)],
    }));
    expect(input.references).toHaveLength(9);
    const prompt = input.prompt + "景".repeat(7000 - [...input.prompt].length);
    expect(validateComicVideoInput({ ...input, prompt })).toEqual([]);
    expect(validateComicVideoInput({ ...input, prompt: prompt + "景", timedReferences: [...input.timedReferences!, audio(43)] }))
      .toMatchObject([{ code: "REFERENCE_LIMIT", field: "files", actual: 13, max: 12 },
        { code: "PROMPT_TOO_LONG", field: "prompt", actual: 7001, max: 7000 }]);
    expect(validateComicVideoInput({ ...input, references: [], timedReferences: [audio(40)] }))
      .toContainEqual({ code: "REFERENCE_MODE_CONFLICT" });
  });

  it("freezes the last frame only in strict frame mode", () => {
    const lastFrame = { ...image(11), mediaId: uuid(11), version: 3 };
    const strict = freeze(buildComicGenerationInput({ ...base, mode: "from_keyframe", firstFrame: keyframe, lastFrame }));
    expect(comicFrozenGenerationSchema.parse(strict)).toMatchObject({
      firstFrame: { mediaId: keyframe.mediaId }, lastFrame: { mediaId: uuid(11), version: 3 }, references: [],
    });
    expect(buildComicGenerationInput({ ...base, mode: "references", lastFrame, timedReferences: [audio(40)] })).toMatchObject({
      ok: false, issues: expect.arrayContaining([{ code: "REFERENCE_MODE_CONFLICT" }]),
    });
  });

  it("checks media durations separately, uses matching prompt indices, and validates the edit source", () => {
    const input = freeze(buildComicGenerationInput({
      ...base, mode: "references", timedReferences: [audio(40, 15_000), video(42, 15_000), audio(41, 15_000), video(43, 15_000)],
      clip: { ...clip, draft: { ...clip.draft, durationMs: 30_000, scene: "@音频2和@Video2" } },
    }));
    expect(comicFrozenGenerationSchema.parse(input).timedReferences).toHaveLength(4);
    expect(input.prompt).toContain("@Audio2 is the audio reference");
    const exceeded = validateComicVideoInput({
      ...input, durationMs: 31_000, timedReferences: [audio(40, 15_001), audio(41, 15_000), video(42, 15_000), video(43, 15_001)],
      prompt: input.prompt + " @Video3 @图片0",
    });
    expect(exceeded).toMatchObject([
      { field: "outputSeconds", actual: 31, min: 4, max: 30 },
      { field: "audioSeconds", actual: 30.001, max: 30 }, { field: "videoSeconds", actual: 30.001, max: 30 },
      { code: "PROMPT_REFERENCE_UNBOUND", actual: "@Video3" }, { code: "PROMPT_REFERENCE_UNBOUND", actual: "@图片0" },
    ]);
    expect(validateComicVideoInput({ ...input, modelId: "doubao-seedance-2-0", durationMs: 15_000, timedReferences: [] })
      .some(issue => issue.code === "DURATION_UNSUPPORTED")).toBe(false);
    expect(validateComicVideoInput({ ...input, modelId: "doubao-seedance-2-0", durationMs: 16_000 })[0])
      .toMatchObject({ field: "outputSeconds", actual: 16, max: 15 });
    expect(buildComicGenerationInput({ ...base, mode: "edit", timedReferences: [video(42, 3999)] })).toMatchObject({
      ok: false, issues: [{ code: "REFERENCE_UNSUPPORTED", field: "seconds", min: 4 }],
    });
    expect(freeze(buildComicGenerationInput({ ...base, mode: "edit", timedReferences: [video(42, 4500)] }))).toMatchObject({
      sourceDuration: true, durationMs: 4500,
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

  it("splits scripts, extracts excerpts, applies partial script enhancements without offset drift, and normalizes shot shares", () => {
    const script = "第一段：雨夜推门。\n\n第二段：柜台交锋。\n\n第三段：留下纸条。";
    const segments = splitComicScriptSegments(script);
    expect(segments).toHaveLength(3);
    expect(segments.map(s => script.slice(s.start, s.end))).toEqual([
      "第一段：雨夜推门。",
      "第二段：柜台交锋。",
      "第三段：留下纸条。",
    ]);

    const mergedCap = splitComicScriptSegments("甲\n\n乙\n\n丙\n\n丁", 2);
    expect(mergedCap).toHaveLength(2);

    const excerpt = extractComicScriptExcerptSegments(script, [
      { start: 0, end: 11 },
      { start: 21, end: 31 },
    ]);
    expect(excerpt?.map(s => s.original)).toEqual(["第一段：雨夜推门。", "第三段：留下纸条。"]);
    expect(extractComicScriptExcerptSegments(script, [
      { start: 0, end: 15 },
      { start: 10, end: 25 },
    ])).toBeNull();

    // Adopt only segment 2 (index 1); segment 1 & 3 retain original verbatim
    const twoSegs = splitComicScriptSegments("第一段原稿\n\n第二段原稿");
    const afterSeg2 = applyComicScriptEnhancements("第一段原稿\n\n第二段原稿", [
      { ...twoSegs[0]!, suggested: "第一段增强", status: "pending" },
      { ...twoSegs[1]!, suggested: "第二段增强", status: "applied", appliedText: "第二段精修" },
    ]);
    expect(afterSeg2).toBe("第一段原稿\n\n第二段精修");

    // Subsequent adoption of segment 1 still uses original offsets without drift
    const afterBoth = applyComicScriptEnhancements("第一段原稿\n\n第二段原稿", [
      { ...twoSegs[0]!, suggested: "第一段增强", status: "applied" },
      { ...twoSegs[1]!, suggested: "第二段增强", status: "applied", appliedText: "第二段精修" },
    ]);
    expect(afterBoth).toBe("第一段增强\n\n第二段精修");

    // Shot durationShare normalization & rebalancing always yield positive integers summing to 100
    for (const input of [[50, 50], [33, 33, 33], [1, 1, 98], [0, 0, 0], [80]]) {
      const normalized = normalizeShotDurationShares(input);
      expect(normalized.every(v => Number.isInteger(v) && v >= 1)).toBe(true);
      expect(normalized.reduce((a, b) => a + b, 0)).toBe(100);
    }
    const shots = [
      { id: uuid(1), framingKey: "wide", movementKey: "fixed", description: "A", durationShare: 34 },
      { id: uuid(2), framingKey: "medium", movementKey: "push", description: "B", durationShare: 33 },
      { id: uuid(3), framingKey: "close_up", movementKey: "fixed", description: "C", durationShare: 33 },
    ];
    const rebalanced = rebalanceShotDurationShares(shots, 1, 60);
    expect(rebalanced[1]?.durationShare).toBe(60);
    expect(rebalanced.every(s => Number.isInteger(s.durationShare) && s.durationShare >= 1)).toBe(true);
    expect(rebalanced.reduce((sum, s) => sum + s.durationShare, 0)).toBe(100);

    // Director enhance input/apply/dismiss schemas
    expect(comicDirectorInputSchema.safeParse({
      requestId: uuid(10), expectedRevision: 1, language: "zh", action: "enhance", enhance: { scope: "script_full" },
    }).success).toBe(true);
    expect(comicDirectorInputSchema.safeParse({
      requestId: uuid(11), expectedRevision: 1, language: "zh", action: "enhance",
      enhance: { scope: "clips", clipIds: [uuid(20), uuid(21)] },
    }).success).toBe(true);
    expect(comicDirectorInputSchema.safeParse({
      requestId: uuid(12), expectedRevision: 1, language: "zh", action: "enhance",
    }).success).toBe(false);
    expect(comicDirectorInputSchema.safeParse({
      requestId: uuid(13), expectedRevision: 1, language: "zh", action: "script", text: "",
    }).success).toBe(false);
    expect(comicDirectorApplySchema.safeParse({
      expectedRevision: 2, decision: "enhance", scriptItems: [{ index: 1, text: "已修改段" }],
    }).success).toBe(true);
    expect(comicDirectorDismissSchema.safeParse({ itemIndex: 0 }).success).toBe(true);
    expect(comicDirectorDismissSchema.safeParse({}).success).toBe(true);
  });

  it("models and computes the 3-tier drama -> episode -> clip hierarchy", () => {
    expect(createComicDramaSchema.safeParse({
      title: "雨夜便利店",
      synopsis: "都市奇幻短剧",
      styleKey: "thick_painting",
      aspectRatio: "9:16",
    }).success).toBe(true);
    expect(createComicDramaSchema.safeParse({ title: "" }).success).toBe(false);

    expect(comicDramaSchema.safeParse({
      id: uuid(99),
      title: "雨夜便利店",
      synopsis: "都市奇幻短剧",
      styleKey: "thick_painting",
      aspectRatio: "9:16",
      videoModel: "doubao-seedance-2-5",
      revision: 2,
      archivedAt: null,
    }).success).toBe(true);

    // Tier-2 episodes require a parent dramaId
    expect(comicDramaSeriesSchema.safeParse({ ...series, dramaId: undefined }).success).toBe(false);
    expect(comicDramaSeriesSchema.safeParse(series).success).toBe(true);

    const hierarchy = buildComicDramaHierarchy(
      {
        id: uuid(99),
        title: "雨夜便利店",
        synopsis: "都市奇幻短剧",
        revision: 2,
      },
      { ...series, id: uuid(2), title: "第 2 集：风铃", episodeNo: 2 },
      [
        {
          id: uuid(20),
          dramaId: uuid(99),
          episodeId: uuid(2),
          ordinal: 1,
          revision: 1,
          selectionRevision: 1,
          draft: {
            schemaVersion: 1,
            durationMs: 4000,
            scene: "门口风铃",
            shots: [{ id: uuid(30), framingKey: "medium", movementKey: "fixed", description: "特写", durationShare: 100 }],
            lines: [],
          },
        },
        {
          id: uuid(21),
          dramaId: uuid(99),
          episodeId: uuid(2),
          ordinal: 2,
          revision: 1,
          selectionRevision: 1,
          draft: {
            schemaVersion: 1,
            durationMs: 5000,
            scene: "柜台重逢",
            shots: [{ id: uuid(31), framingKey: "closeup", movementKey: "fixed", description: "重逢", durationShare: 100 }],
            lines: [],
          },
        },
      ],
      2,
    );

    expect(hierarchy.drama.title).toBe("雨夜便利店");
    expect(hierarchy.drama.episodeCount).toBe(2);
    expect(hierarchy.episode.episodeNo).toBe(2);
    expect(hierarchy.episode.title).toBe("第 2 集：风铃");
    expect(hierarchy.episode.clipCount).toBe(2);
    expect(hierarchy.clips.map(clip => `${clip.ordinal}:${clip.episodeId}:${clip.scene}:${clip.durationMs}`)).toEqual([
      `1:${uuid(2)}:门口风铃:4000`,
      `2:${uuid(2)}:柜台重逢:5000`,
    ]);
  });
});

describe("P1 audio modes, 24fps export policy, real-time checks, and one-click model compatibility", () => {
  it("validates 3 audio modes and generates native_audio prompt without requiring reference audio", () => {
    expect(resolveComicVideoAudioMode(undefined, false)).toBe("silent_tts");
    expect(resolveComicVideoAudioMode(undefined, true)).toBe("reference_audio");
    expect(resolveComicVideoAudioMode("native_audio", false)).toBe("native_audio");

    const nativeClip: ComicDramaClip = {
      ...clip,
      draft: comicDramaClipDraftSchema.parse({
        ...clip.draft,
        lines: [{ id: uuid(801), speaker: "Lin", text: "Hello there.", emotionKey: null, speed: 1 }],
        videoInputs: { references: [], audioMode: "native_audio" },
      }),
    };
    const builtNative = buildComicGenerationInput({
      series, clip: nativeClip, cast, modelId: "doubao-seedance-2-5", mode: "references",
    });
    expect(builtNative.ok).toBe(true);
    if (builtNative.ok) {
      expect(builtNative.input.audioMode).toBe("native_audio");
      expect(builtNative.input.prompt).toContain("synchronized spoken dialogue");
    }

    const refAudioMissingClip: ComicDramaClip = {
      ...clip,
      draft: comicDramaClipDraftSchema.parse({
        ...clip.draft,
        videoInputs: { references: [], audioMode: "reference_audio" },
      }),
    };
    const builtMissing = buildComicGenerationInput({
      series, clip: refAudioMissingClip, cast, modelId: "doubao-seedance-2-5", mode: "references",
    });
    expect(builtMissing).toMatchObject({ ok: false, issues: [{ code: "AUDIO_REFERENCE_REQUIRED", field: "audioMode" }] });
  });

  it("resolves 24fps native export for all-24fps/23.976fps sources and 30fps CFR for mixed fps", () => {
    expect(resolveComicRenderFps([24, 24], "auto")).toMatchObject({ fps: 24, policy: "native", allSources24Fps: true, mixedSourceFps: false });
    expect(resolveComicRenderFps([24000 / 1001, 24], "auto")).toMatchObject({ fps: 24, policy: "native", allSources24Fps: true });
    expect(resolveComicRenderFps([24, 30], "auto")).toMatchObject({ fps: 30, policy: "cfr_convert", allSources24Fps: false, mixedSourceFps: true });
    expect(resolveComicRenderFps([24, 30], "24")).toMatchObject({ fps: 24, policy: "cfr_convert", mixedSourceFps: true });
    expect(resolveComicRenderFps([24, 24], "30")).toMatchObject({ fps: 30, policy: "cfr_convert", mixedSourceFps: false });
    expect(comicRenderDurationToleranceMs(24)).toBe(42);
    expect(comicRenderDurationToleranceMs(30)).toBe(34);
  });

  it("flags model incompatibilities in real time and non-destructively adapts & restores across Seedance 2.5 <-> MiniMax H3", () => {
    const h3 = comicVideoProfile("MiniMax-H3")!;
    const s25 = comicVideoProfile("doubao-seedance-2-5")!;
    expect(mapComicVideoResolution("720p", h3)).toBe("768P");
    expect(mapComicVideoResolution("4k", h3)).toBe("2K");
    expect(mapComicVideoResolution("768P", s25)).toBe("720p");
    expect(mapComicVideoResolution("2K", s25)).toBe("1080p");

    // Seedance 2.5 clip with 20s, 4k, extend sourceDuration, 2 cast refs + 1 scene + 1 style + 4 props + 4 extra images = 12 images
    const heavyClip: ComicDramaClip = {
      ...clip,
      draft: comicDramaClipDraftSchema.parse({
        ...clip.draft,
        durationMs: 20_000,
        cast: [{ characterId: snapshot.characterId, slotKey: "front", expressionKey: "smile" }],
        sceneRef: { materialId: uuid(810), mediaId: uuid(811), name: "雨夜街道" },
        propRefs: Array.from({ length: 4 }, (_, i) => ({ materialId: uuid(820 + i), mediaId: uuid(830 + i), name: `道具${i + 1}` })),
        videoInputs: {
          resolution: "4k",
          sourceDuration: true,
          references: Array.from({ length: 4 }, (_, i) => ({
            kind: "image" as const, materialId: uuid(840 + i), mediaId: uuid(850 + i), name: `附加图${i + 1}`,
          })),
        },
      }),
    };

    // Real-time checks against MiniMax H3 catch duration, resolution, image count, extend
    const liveIssues = checkComicClipIssues(
      { videoModel: "MiniMax-H3" }, heavyClip, [{ ...cast[0], hasUpdates: false }], { hasStyleRef: true },
    );
    expect(liveIssues.map(i => i.code)).toEqual(expect.arrayContaining([
      "REFERENCE_LIMIT_EXCEEDED",
      "DURATION_OUT_OF_RANGE",
      "RESOLUTION_UNSUPPORTED",
      "VIDEO_MODE_UNSUPPORTED",
    ]));

    // Switch analysis reports affected clip and non-destructive adaptation without silently clamping >15s duration
    const report = analyzeComicModelSwitch([heavyClip], "MiniMax-H3", { hasStyleRef: true });
    expect(report?.affectedClips).toHaveLength(1);
    expect(report?.autoAdaptableCount).toBe(1);
    expect(report?.durationNeedsAttentionCount).toBe(1);
    const adapted = report!.affectedClips[0].adaptedDraft;
    expect(adapted.durationMs).toBe(20_000);
    expect(adapted.videoInputs?.resolution).toBe("2K");
    expect(adapted.videoInputs?.sourceDuration).toBeUndefined();
    expect(adapted.videoInputs?.modelAdaptation?.originalResolution).toBe("4k");
    expect(adapted.videoInputs?.modelAdaptation?.originalSourceDuration).toBe(true);
    // 12 images -> 9 kept (cast slot+expr=2, scene=1, style=1, 4 props=4, 1 extra=1), 3 lowest-priority extra images folded!
    expect(adapted.videoInputs?.modelAdaptation?.foldedExtraImageMediaIds).toEqual([uuid(851), uuid(852), uuid(853)]);
    expect(adapted.videoInputs?.modelAdaptation?.foldedPropMediaIds).toBeUndefined();
    expect(adapted.videoInputs?.modelAdaptation?.foldedSceneRef).toBeUndefined();
    expect(countComicClipFoldedReferences(adapted, { hasStyleRef: true })).toBe(3);
    expect(countComicClipReferences({ ...heavyClip, draft: adapted }, { hasStyleRef: true })).toBe(9);
    // Original extra references remain intact in draft.videoInputs.references!
    expect(adapted.videoInputs?.references).toHaveLength(4);

    // Explicit clampDuration compresses 20s -> 15s when requested
    const clamped = adaptComicClipDraftForModel(heavyClip.draft, "MiniMax-H3", { hasStyleRef: true, clampDuration: true });
    expect(clamped.draft.durationMs).toBe(15_000);

    // Switching back to Seedance 2.5 restores original 4k resolution, sourceDuration=true, and unfolds all 3 images!
    const restored = adaptComicClipDraftForModel(adapted, "doubao-seedance-2-5", { hasStyleRef: true });
    expect(restored.changed).toBe(true);
    expect(restored.draft.videoInputs?.resolution).toBe("4k");
    expect(restored.draft.videoInputs?.sourceDuration).toBe(true);
    expect(restored.draft.videoInputs?.modelAdaptation).toBeUndefined();
    expect(countComicClipReferences({ ...heavyClip, draft: restored.draft }, { hasStyleRef: true })).toBe(12);
  });
});

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  comicTimelineOverflow, comicTimelineSchema, layoutComicTimeline, type ComicEdit, type ComicRender, type ComicTimeline,
} from "@lot-agent/core/comic-drama";
import { ComicTempPreviewDialog } from "./ComicTempPreviewDialog.js";
import { ComicTimelineTracks } from "./ComicTimelineTracks.js";
import { comicEditApi } from "./edit-api.js";
import {
  computeRulerTicks, fixAllTimelineOverflows, fixOverlayOverflow, getOverlayItemTitle,
  getTrackShiftBounds, moveOverlayItem, resizeOverlayItem, resolveAnchorForMove,
  shiftOverlayTrack, snapEdgeMs, snapTimelineMs,
} from "./timeline-ops.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function makeTimeline(): ComicTimeline {
  return comicTimelineSchema.parse({
    schemaVersion: 1,
    aspectRatio: "9:16",
    video: [
      {
        id: uuid(1), takeId: uuid(101), sourceDurationMs: 4000, inMs: 0, outMs: 4000,
        volume: 1, transitionIn: { kind: "cut", durationMs: 0 },
      },
      {
        id: uuid(2), takeId: uuid(102), sourceDurationMs: 6000, inMs: 0, outMs: 6000,
        volume: 1, transitionIn: { kind: "cut", durationMs: 0 },
      },
    ],
    voice: [
      {
        id: uuid(10), mediaId: uuid(201), lineId: uuid(301),
        anchor: { kind: "clip", videoItemId: uuid(1), offsetMs: 2500 },
        durationMs: 1200, sourceInMs: 0, volume: 1, fadeInMs: 100, fadeOutMs: 100, loop: false,
      },
      {
        id: uuid(11), mediaId: uuid(202), lineId: uuid(302),
        anchor: { kind: "clip", videoItemId: uuid(2), offsetMs: 500 },
        durationMs: 1500, sourceInMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false,
      },
    ],
    sfx: [
      {
        id: uuid(20), mediaId: uuid(203),
        anchor: { kind: "timeline", offsetMs: 1000 },
        durationMs: 800, sourceInMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false,
      },
    ],
    music: [
      {
        id: uuid(30), mediaId: uuid(204),
        anchor: { kind: "timeline", offsetMs: 0 },
        durationMs: 8000, sourceInMs: 0, volume: 0.3, fadeInMs: 200, fadeOutMs: 300, loop: true,
      },
    ],
    subtitles: [
      {
        id: uuid(40), lineId: uuid(301),
        anchor: { kind: "clip", videoItemId: uuid(1), offsetMs: 2500 },
        durationMs: 1200, text: "第一句台词",
      },
      {
        id: uuid(41), lineId: uuid(302),
        anchor: { kind: "clip", videoItemId: uuid(2), offsetMs: 500 },
        durationMs: 1500, text: "第二句台词",
      },
    ],
  });
}

describe("timeline-ops pure timeline manipulation", () => {
  it("converts clip-anchored items to timeline anchor only when crossing clip bounds", () => {
    const timeline = makeTimeline();
    const layout = layoutComicTimeline(timeline);
    const clipAnchor = { kind: "clip" as const, videoItemId: uuid(1), offsetMs: 2500 };

    // Inside clip 1 (0..4000ms): stays clip-anchored
    expect(resolveAnchorForMove(timeline, layout, clipAnchor, 1500, 1200)).toEqual({
      kind: "clip", videoItemId: uuid(1), offsetMs: 1500,
    });

    // Crosses clip 1 -> clip 2 boundary (4500..5700ms): seamlessly converts to timeline anchor
    expect(resolveAnchorForMove(timeline, layout, clipAnchor, 4500, 1200)).toEqual({
      kind: "timeline", offsetMs: 4500,
    });
  });

  it("moves a single voice item +2s across clip cut without overflow and syncs its linked subtitle", () => {
    const timeline = makeTimeline();
    const res = moveOverlayItem(timeline, "voice", uuid(10), 4500, { linkSubtitles: true });
    expect(res.appliedDeltaMs).toBe(2000);
    expect(res.linkedCount).toBe(1);
    expect(comicTimelineSchema.safeParse(res.timeline).success).toBe(true);
    expect(comicTimelineOverflow(res.timeline)).toEqual([]);

    const nextLayout = layoutComicTimeline(res.timeline);
    expect(nextLayout.voice[0]).toEqual({ id: uuid(10), startMs: 4500, endMs: 5700 });
    expect(nextLayout.subtitles[0]).toEqual({ id: uuid(40), startMs: 4500, endMs: 5700 });
    expect(res.timeline.voice[0]!.anchor).toEqual({ kind: "timeline", offsetMs: 4500 });

    // Without subtitle linking, subtitle stays put
    const unlinked = moveOverlayItem(timeline, "voice", uuid(10), 4500, { linkSubtitles: false });
    expect(unlinked.linkedCount).toBe(0);
    expect(layoutComicTimeline(unlinked.timeline).subtitles[0]!.startMs).toBe(2500);
  });

  it("shifts the entire voiceover track +2s cleanly and clamps uniformly at timeline bounds", () => {
    const timeline = makeTimeline();
    const bounds = getTrackShiftBounds(timeline, "voice");
    expect(bounds).toEqual({
      count: 2,
      minStartMs: 2500,
      maxEndMs: 6000,
      maxShiftEarlierMs: 2500,
      maxShiftLaterMs: 4000,
      totalDurationMs: 10000,
    });

    // Move entire voiceover track 2 seconds later
    const later = shiftOverlayTrack(timeline, "voice", 2000, { linkSubtitles: true });
    expect(later.appliedDeltaMs).toBe(2000);
    expect(later.clamped).toBe(false);
    expect(later.movedCount).toBe(2);
    expect(later.linkedCount).toBe(2);
    expect(comicTimelineOverflow(later.timeline)).toEqual([]);

    const laterLayout = layoutComicTimeline(later.timeline);
    expect(laterLayout.voice.map(v => v.startMs)).toEqual([4500, 6500]);
    expect(laterLayout.subtitles.map(s => s.startMs)).toEqual([4500, 6500]);
    // Voice 2 stayed inside clip 2 (4000..10000), so its clip anchor is preserved!
    expect(later.timeline.voice[1]!.anchor).toEqual({ kind: "clip", videoItemId: uuid(2), offsetMs: 2500 });

    // Shift earlier beyond 0ms: uniformly clamps at 2500ms so relative spacing (2000ms) is preserved
    const earlier = shiftOverlayTrack(timeline, "voice", -5000, { linkSubtitles: true });
    expect(earlier.appliedDeltaMs).toBe(-2500);
    expect(earlier.clamped).toBe(true);
    expect(layoutComicTimeline(earlier.timeline).voice.map(v => v.startMs)).toEqual([0, 2000]);

    // Partial ripple shift starting from item 2 only
    const fromSecond = shiftOverlayTrack(timeline, "voice", 1000, { linkSubtitles: true, fromItemId: uuid(11) });
    expect(fromSecond.movedCount).toBe(1);
    expect(fromSecond.linkedCount).toBe(1);
    expect(layoutComicTimeline(fromSecond.timeline).voice.map(v => v.startMs)).toEqual([2500, 5500]);
  });

  it("resizes audio and subtitles safely, capping non-loop audio by source duration and clamping fades", () => {
    const timeline = makeTimeline();
    // Non-loop voice has sourceDurationMs = 1500, currently 1200ms @ 2500..3700 -> capped at 4000ms (2500+1500)
    const capped = resizeOverlayItem(timeline, "voice", uuid(10), "end", 7000, 1500);
    expect(capped.voice[0]!.durationMs).toBe(1500);

    // Loop music can extend freely up to total duration (10000ms)
    const extendedMusic = resizeOverlayItem(timeline, "music", uuid(30), "end", 10000, 2000);
    expect(extendedMusic.music[0]!.durationMs).toBe(10000);

    // Trimming audio start right by 600ms advances sourceInMs and clamps fades inside remaining duration
    const audioWithBigFades = comicTimelineSchema.parse({
      ...timeline,
      voice: [
        { ...timeline.voice[0]!, sourceInMs: 400, durationMs: 1200, fadeInMs: 600, fadeOutMs: 600 },
        timeline.voice[1]!,
      ],
    });
    const trimmedStart = resizeOverlayItem(audioWithBigFades, "voice", uuid(10), "start", 3300, 2000);
    expect(trimmedStart.voice[0]!.durationMs).toBe(400);
    expect(trimmedStart.voice[0]!.sourceInMs).toBe(1200);
    expect(trimmedStart.voice[0]!.fadeInMs + trimmedStart.voice[0]!.fadeOutMs).toBeLessThanOrEqual(400);
    expect(comicTimelineSchema.safeParse(trimmedStart).success).toBe(true);

    // Trimming subtitle end
    const resizedSub = resizeOverlayItem(timeline, "subtitles", uuid(40), "end", 4200);
    expect(resizedSub.subtitles[0]!.durationMs).toBe(1700);
    expect(resizedSub.subtitles[0]!.anchor).toEqual({ kind: "timeline", offsetMs: 2500 });
  });

  it("snaps timeline positions and edges cleanly and fixes anchor overflows", () => {
    const snap = snapTimelineMs(3930, 1000, [0, 4000, 10000], 120, 10000);
    expect(snap).toEqual({ startMs: 4000, snapLineMs: 4000 });

    const edge = snapEdgeMs(3950, [0, 4000, 10000], 100, 1000, 10000);
    expect(edge).toEqual({ ms: 4000, snapLineMs: 4000 });

    // Create a clip-overflow timeline manually (clip 1 is 4000ms, voice starts at 3500ms with 1200ms duration)
    const base = makeTimeline();
    const broken = comicTimelineSchema.parse({
      ...base,
      voice: [
        { ...base.voice[0]!, anchor: { kind: "clip", videoItemId: uuid(1), offsetMs: 3500 } },
        base.voice[1]!,
      ],
      sfx: [
        { ...base.sfx[0]!, anchor: { kind: "timeline", offsetMs: 9500 }, durationMs: 1200 },
      ],
    });
    expect(comicTimelineOverflow(broken)).toEqual([uuid(10), uuid(20)]);

    const fixedOne = fixOverlayOverflow(broken, "voice", uuid(10));
    expect(fixedOne.voice[0]!.anchor).toEqual({ kind: "timeline", offsetMs: 3500 });
    expect(fixedOne.voice[0]!.durationMs).toBe(1200);

    const fixedAll = fixAllTimelineOverflows(broken);
    expect(comicTimelineOverflow(fixedAll)).toEqual([]);
    expect(fixedAll.sfx[0]!.durationMs).toBe(500);
  });

  it("generates readable ruler ticks and track item titles", () => {
    const ticks = computeRulerTicks(10000, 1);
    expect(ticks[0]).toEqual({ ms: 0, label: "0s", major: true });
    expect(ticks[ticks.length - 1]!.ms).toBe(10000);

    const timeline = makeTimeline();
    const t = (key: string, params?: readonly (string | number)[]) =>
      params ? key.replace(/\{(\d+)\}/g, (_, i) => String(params[Number(i)])) : key;
    expect(getOverlayItemTitle(timeline, "voice", 0, [], {}, t)).toBe("配音 1 · 第一句台词");
    expect(getOverlayItemTitle(timeline, "music", 0, [], { [uuid(204)]: "雨夜钢琴曲" }, t)).toBe("雨夜钢琴曲");
    expect(getOverlayItemTitle(timeline, "sfx", 0, [], {}, t)).toBe("音效 1");
  });
});

describe("ComicTimelineTracks UI usability & compatibility", () => {
  it("supports one-click +2s whole voice track shift, quick nudge, and preserves 5-row Playwright selectors", () => {
    const timeline = makeTimeline();
    const updates: ComicTimeline[] = [];
    const onUpdate = vi.fn((next: ComicTimeline) => { updates.push(next); });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const renderWith = (current: ComicTimeline) => {
      act(() => {
        root.render(
          createElement(ComicTimelineTracks, {
            timeline: current,
            videoSources: [],
            audioSources: [
              { id: uuid(201), durationMs: 3000 },
              { id: uuid(202), durationMs: 3000 },
              { id: uuid(203), durationMs: 3000 },
              { id: uuid(204), durationMs: 12000 },
            ],
            audioNames: { [uuid(204)]: "主题曲" },
            selectedVideo: uuid(1),
            positionMs: 0,
            seek: () => {},
            selectVideo: () => {},
            update: next => {
              onUpdate(next);
              renderWith(next);
            },
            disabled: false,
            canUndo: false,
            canRedo: false,
            onUndo: () => {},
            onRedo: () => {},
          }),
        );
      });
    };

    try {
      renderWith(timeline);

      // Strictly 5 .comic-track-row elements for Playwright compatibility
      expect(container.querySelectorAll(".comic-track-row").length).toBe(5);

      // Every lane[data-track] only contains clip buttons (handles are spans, shift btn is in .comic-track-head)
      expect(container.querySelectorAll('.comic-track-lane[data-track="voice"] button').length).toBe(2);
      expect(container.querySelectorAll('.comic-track-lane[data-track="subtitles"] button').length).toBe(2);
      expect(container.querySelectorAll('.comic-track-lane[data-track="music"] button')[0]?.textContent).toBe("主题曲");

      // Open whole-track shift on Voice track and click "延后 2 秒"
      const voiceShiftBtn = container.querySelector('button[aria-label="整轨平移 配音轨"]') as HTMLButtonElement;
      expect(voiceShiftBtn).toBeTruthy();
      act(() => { voiceShiftBtn.click(); });

      const shiftPanel = container.querySelector(".comic-track-shift-panel")!;
      expect(shiftPanel).toBeTruthy();
      const later2sBtn = Array.from(shiftPanel.querySelectorAll("button")).find(b => b.textContent === "延后 2 秒")!;
      expect(later2sBtn).toBeTruthy();
      act(() => { later2sBtn.click(); });

      expect(updates.length).toBe(1);
      const afterShift = updates[0]!;
      expect(comicTimelineOverflow(afterShift)).toEqual([]);
      expect(layoutComicTimeline(afterShift).voice.map(v => v.startMs)).toEqual([4500, 6500]);
      expect(layoutComicTimeline(afterShift).subtitles.map(s => s.startMs)).toEqual([4500, 6500]);

      // Select first voice item and nudge +2s via inspector quick-nudge bar
      const voiceBtn1 = container.querySelectorAll('.comic-track-lane[data-track="voice"] button')[0] as HTMLButtonElement;
      act(() => { voiceBtn1.click(); });
      const quickBar = container.querySelector(".comic-quick-nudge")!;
      const nudgePlus2 = Array.from(quickBar.querySelectorAll("button")).find(b => b.textContent === "+2s")!;
      act(() => { nudgePlus2.click(); });

      expect(updates.length).toBe(2);
      const afterNudge = updates[1]!;
      expect(layoutComicTimeline(afterNudge).voice[0]!.startMs).toBe(6500);
      expect(layoutComicTimeline(afterNudge).subtitles[0]!.startMs).toBe(6500);

      // Legacy inspector fields remain intact
      const inspector = container.querySelector(".comic-track-inspector")!;
      expect(inspector.querySelector('select[name="anchor"]')).toBeTruthy();
      expect(inspector.querySelector('input[name="offset"]')).toBeTruthy();
      expect(inspector.querySelector('input[name="duration"]')).toBeTruthy();
      expect(Array.from(inspector.querySelectorAll("button")).some(b => b.textContent === "应用轨道设置")).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("triggers onPreviewTemp from timeline toolbar", () => {
    const timeline = makeTimeline();
    const onPreviewTemp = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(createElement(ComicTimelineTracks, {
          timeline,
          videoSources: [],
          audioSources: [],
          positionMs: 0,
          seek: () => {},
          selectVideo: () => {},
          update: () => {},
          disabled: false,
          onPreviewTemp,
        }));
      });
      const previewBtn = Array.from(container.querySelectorAll("button"))
        .find(btn => btn.textContent === "试看临时成片");
      expect(previewBtn).toBeTruthy();
      act(() => { previewBtn!.click(); });
      expect(onPreviewTemp).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe("ComicTempPreviewDialog ephemeral preview lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeEdit = (timeline: ComicTimeline): ComicEdit => ({
    id: uuid(500),
    seriesId: uuid(501),
    title: "试看工程",
    revision: 4,
    updatedAt: new Date().toISOString(),
    timeline,
    sources: [],
    audioSources: [],
  });

  it("auto-saves, renders ephemeral preview, and deletes immediately on close", async () => {
    const timeline = makeTimeline();
    const edit = makeEdit(timeline);
    const renderId = uuid(600);
    const ensureSaved = vi.fn(async () => edit);
    const close = vi.fn();

    const startSpy = vi.spyOn(comicEditApi, "startRender").mockResolvedValue({
      id: renderId, editId: edit.id, editRevision: edit.revision, durationMs: 10_000,
      status: "pending", error: null, mediaId: null, title: edit.title,
      createdAt: new Date().toISOString(), recoverable: false, ephemeral: true,
    } satisfies ComicRender);
    const pollSpy = vi.spyOn(comicEditApi, "render").mockResolvedValue({
      id: renderId, editId: edit.id, editRevision: edit.revision, durationMs: 10_000,
      status: "ready", error: null, mediaId: uuid(601), title: edit.title,
      createdAt: new Date().toISOString(), recoverable: false, ephemeral: true,
    } satisfies ComicRender);
    const downloadSpy = vi.spyOn(comicEditApi, "downloadRender").mockResolvedValue({
      url: "/api/public/comic-drama-media/preview.mp4?render=" + renderId + "&inline=1",
      filename: `comic-${renderId}.mp4`,
    });
    const removeSpy = vi.spyOn(comicEditApi, "removeRender").mockResolvedValue({ ok: true });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(ComicTempPreviewDialog, {
          aspectRatio: "9:16",
          ensureSaved,
          close,
        }));
      });
      await act(async () => { await new Promise(r => setTimeout(r, 700)); });

      expect(ensureSaved).toHaveBeenCalledTimes(1);
      expect(startSpy).toHaveBeenCalledWith(edit.id, expect.objectContaining({
        expectedRevision: edit.revision,
        ephemeral: true,
      }));
      expect(pollSpy).toHaveBeenCalled();
      expect(downloadSpy).toHaveBeenCalledWith(renderId, true);

      const video = container.querySelector("video");
      expect(video?.getAttribute("src")).toContain("preview.mp4");

      const closeDeleteBtn = Array.from(container.querySelectorAll("button"))
        .find(btn => btn.textContent === "关闭并删除");
      expect(closeDeleteBtn).toBeTruthy();
      act(() => { closeDeleteBtn!.click(); });

      expect(removeSpy).toHaveBeenCalledWith(renderId, false);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("cancels and deletes active ephemeral render if user closes dialog while rendering", async () => {
    const timeline = makeTimeline();
    const edit = makeEdit(timeline);
    const renderId = uuid(602);
    const ensureSaved = vi.fn(async () => edit);
    const close = vi.fn();

    vi.spyOn(comicEditApi, "startRender").mockResolvedValue({
      id: renderId, editId: edit.id, editRevision: edit.revision, durationMs: 10_000,
      status: "running", error: null, mediaId: null, title: edit.title,
      createdAt: new Date().toISOString(), recoverable: false, ephemeral: true,
    } satisfies ComicRender);
    vi.spyOn(comicEditApi, "render").mockResolvedValue({
      id: renderId, editId: edit.id, editRevision: edit.revision, durationMs: 10_000,
      status: "running", error: null, mediaId: null, title: edit.title,
      createdAt: new Date().toISOString(), recoverable: false, ephemeral: true,
    } satisfies ComicRender);
    const removeSpy = vi.spyOn(comicEditApi, "removeRender").mockResolvedValue({ ok: true });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(ComicTempPreviewDialog, {
          aspectRatio: "9:16",
          ensureSaved,
          close,
        }));
      });

      const cancelBtn = Array.from(container.querySelectorAll("button"))
        .find(btn => btn.textContent === "取消");
      expect(cancelBtn).toBeTruthy();
      act(() => { cancelBtn!.click(); });

      expect(removeSpy).toHaveBeenCalledWith(renderId, false);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

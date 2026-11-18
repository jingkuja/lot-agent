import { describe, expect, it } from "vitest";
import {
  comicDramaCapabilitiesSchema, comicDramaClipSchema, comicDramaRevisionConflictSchema, comicDramaSeriesSchema,
  createComicDramaSeriesSchema, reorderComicDramaClipsSchema, updateComicDramaClipSchema,
} from "@lot-agent/core/comic-drama";
import { comicDramaW1Fixture as fixture } from "./w1-fixture.js";

describe("comic drama W1 contracts", () => {
  const { series, clips } = fixture.workspace;
  const [first, second] = clips;

  it("provides the series and two draft clips for the seven-screen fixture", () => {
    expect(comicDramaSeriesSchema.parse(series)).toEqual(series);
    expect(clips.map(clip => comicDramaClipSchema.parse(clip).draft.durationMs)).toEqual([6000, 8000]);
    expect(comicDramaCapabilitiesSchema.parse({ globle: 1 })).toEqual({ comicDramaEnabled: false });
    expect(comicDramaCapabilitiesSchema.parse({ comicDramaEnabled: true })).toEqual({ comicDramaEnabled: true });
  });

  it("rejects client-supplied owner IDs and unrecognized write fields", () => {
    const newSeries = { title: series.title, styleKey: series.styleKey, aspectRatio: series.aspectRatio, videoModel: series.videoModel };
    expect(createComicDramaSeriesSchema.safeParse(newSeries).success).toBe(true);
    expect(createComicDramaSeriesSchema.safeParse({ ...newSeries, ownerId: series.id }).success).toBe(false);
    expect(updateComicDramaClipSchema.safeParse({ draft: second.draft, expectedRevision: 1, ordinal: 3 }).success).toBe(false);
  });

  it("requires exclusive and stable IDs for the order and shot or line edits", () => {
    expect(reorderComicDramaClipsSchema.safeParse({ expectedRevision: 4, clipIds: [second.id, first.id] }).success).toBe(true);
    expect(reorderComicDramaClipsSchema.safeParse({ expectedRevision: 4, clipIds: [first.id, first.id] }).success).toBe(false);
    const [shot] = second.draft.shots;
    const draft = { ...second.draft, shots: [{ ...shot, durationShare: 20 }] };
    expect(updateComicDramaClipSchema.safeParse({ draft, expectedRevision: 2 }).success).toBe(false);
    expect(updateComicDramaClipSchema.safeParse({ draft: { ...draft, shots: [] }, expectedRevision: 2 }).success).toBe(true);
    const duplicate = { ...shot, durationShare: 50 };
    const duplicateDraft = { ...draft, shots: [duplicate, duplicate] };
    expect(updateComicDramaClipSchema.safeParse({ draft: duplicateDraft, expectedRevision: 2 }).success).toBe(false);
  });

  it("keeps the newer revision available for resolving conflicts", () => {
    expect(comicDramaRevisionConflictSchema.parse(fixture.errors.staleSave.body).currentRevision).toBe(second.revision);
  });

  it("keeps the editor on the original version after adoption", () => {
    const [, cut] = fixture.editor.timeline;
    const adopted = fixture.versions.entries.find(entry => entry.adopted);
    expect(adopted?.clipId).toBe(cut.clipId);
    expect(adopted?.version).toBe(2);
    expect(cut.version).toBe(1);
    expect(fixture.editor.timeline.reduce((total, part) => total + part.outMs - part.inMs, 0)).toBe(13_200);
  });
});

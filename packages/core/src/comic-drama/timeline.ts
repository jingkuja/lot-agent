import { z } from "zod";
import { MarketingCaptionsSchema } from "../marketing-video/index.js";
import type { ComicDramaClipDraft } from "./index.js";

const id = z.string().uuid();
const ms = z.number().int().min(0).max(2_147_483_647);
const volume = z.number().min(0).max(2);
const video = z.object({
  id, takeId: id, sourceDurationMs: ms, inMs: ms, outMs: ms, volume,
  transitionIn: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("cut"), durationMs: z.literal(0) }).strict(),
    z.object({ kind: z.enum(["crossfade", "black"]), durationMs: ms.min(1) }).strict(),
  ]),
}).strict();
const anchor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("timeline"), offsetMs: ms }).strict(),
  z.object({ kind: z.literal("clip"), videoItemId: id, offsetMs: ms }).strict(),
]);
const audio = z.object({
  id, mediaId: id, lineId: id.optional(), anchor, durationMs: ms.min(1), sourceInMs: ms, volume,
  fadeInMs: ms, fadeOutMs: ms, loop: z.boolean(),
}).strict();
const subtitle = z.object({ id, lineId: id.optional(), anchor, durationMs: ms.min(1), text: z.string().trim().min(1).max(2000) }).strict();
const captionStyle = MarketingCaptionsSchema.pick({ size: true, position: true, color: true });

export const comicTimelineSchema = z.object({
  schemaVersion: z.literal(1), aspectRatio: z.enum(["9:16", "16:9", "1:1"]),
  video: z.array(video), voice: z.array(audio), sfx: z.array(audio), music: z.array(audio), subtitles: z.array(subtitle),
  captionStyle: captionStyle.optional(),
}).strict().superRefine((timeline, ctx) => {
  const all = [...timeline.video, ...timeline.voice, ...timeline.sfx, ...timeline.music, ...timeline.subtitles];
  if (new Set(all.map(item => item.id)).size !== all.length) ctx.addIssue({ code: "custom", message: "Timeline item IDs must be unique" });
  const videoIds = new Set(timeline.video.map(item => item.id));
  timeline.video.forEach((item, index) => {
    const previous = timeline.video[index - 1];
    const duration = item.outMs - item.inMs;
    const overlap = item.transitionIn.durationMs;
    const outgoing = timeline.video[index + 1]?.transitionIn.durationMs ?? 0;
    if (duration <= 0 || item.outMs > item.sourceDurationMs || overlap + outgoing >= duration ||
      (overlap > 0 && (!previous || overlap >= previous.outMs - previous.inMs))) {
      ctx.addIssue({ code: "custom", path: ["video", index], message: "Invalid trim or transition" });
    }
  });
  for (const [key, items] of [["voice", timeline.voice], ["sfx", timeline.sfx], ["music", timeline.music], ["subtitles", timeline.subtitles]] as const) {
    items.forEach((item, index) => {
      if (item.anchor.kind === "clip" && !videoIds.has(item.anchor.videoItemId)) {
        ctx.addIssue({ code: "custom", path: [key, index, "anchor"], message: "Clip anchor must refer to a video item" });
      }
      if ("fadeInMs" in item && item.fadeInMs + item.fadeOutMs > item.durationMs) {
        ctx.addIssue({ code: "custom", path: [key, index], message: "Fades must fit inside the audio item" });
      }
    });
  }
});

export type ComicTimeline = z.infer<typeof comicTimelineSchema>;
export const comicOverlayTracks = ["voice", "music", "sfx", "subtitles"] as const;

export function layoutComicTimeline(timeline: ComicTimeline) {
  let durationMs = 0;
  const video = timeline.video.map(item => {
    const startMs = durationMs - item.transitionIn.durationMs;
    durationMs = startMs + item.outMs - item.inMs;
    return { id: item.id, startMs, endMs: durationMs };
  });
  // Clip offsets are measured from the trimmed item's position, including its transition.
  const byId = new Map(video.map(item => [item.id, item.startMs]));
  const position = <T extends { id: string; anchor: z.infer<typeof anchor>; durationMs: number }>(items: T[]) => items.map(item => {
    const startMs = item.anchor.offsetMs + (item.anchor.kind === "clip" ? byId.get(item.anchor.videoItemId)! : 0);
    return { id: item.id, startMs, endMs: startMs + item.durationMs };
  });
  return {
    video, durationMs, voice: position(timeline.voice), sfx: position(timeline.sfx), music: position(timeline.music),
    subtitles: position(timeline.subtitles),
  };
}

export const COMIC_RENDER_FPS = 30;
export const COMIC_RENDER_MAX_MS = 300_000;
export const COMIC_RENDER_MAX_VIDEO_CLIPS = 60;
export const COMIC_RENDER_MAX_AUDIO_ITEMS = 240;
/** Max inputs for a single FFmpeg composition pass (audio tracks premix into stems when total exceeds this). */
export const COMIC_RENDER_MAX_INPUTS = 64;
export const comicFrame = (timeMs: number) => Math.round(timeMs * COMIC_RENDER_FPS / 1000);

export function comicTimelineOverflow(timeline: ComicTimeline) {
  const layout = layoutComicTimeline(timeline);
  const lengths = new Map(timeline.video.map(item => [item.id, item.outMs - item.inMs]));
  return comicOverlayTracks.flatMap(track => timeline[track].filter(item => {
    const end = item.anchor.offsetMs + item.durationMs;
    return end > (item.anchor.kind === "clip" ? lengths.get(item.anchor.videoItemId) ?? 0 : layout.durationMs);
  }).map(item => item.id));
}

export function comicRenderIssue(timeline: ComicTimeline) {
  const layout = layoutComicTimeline(timeline);
  if (!timeline.video.length) return "RENDER_NO_VIDEO";
  const audioCount = timeline.voice.length + timeline.sfx.length + timeline.music.length;
  if (layout.durationMs > COMIC_RENDER_MAX_MS ||
    timeline.video.length > COMIC_RENDER_MAX_VIDEO_CLIPS ||
    audioCount > COMIC_RENDER_MAX_AUDIO_ITEMS) return "RENDER_LIMIT";
  if (comicTimelineOverflow(timeline).length) return "RENDER_TRACK_OVERFLOW";
  if (layout.video.some((item, index) => {
    const start = comicFrame(item.startMs), end = comicFrame(item.endMs);
    const priorEnd = index ? comicFrame(layout.video[index - 1].endMs) : start;
    const nextStart = index + 1 < layout.video.length ? comicFrame(layout.video[index + 1].startMs) : end;
    return end <= start || nextStart <= priorEnd || (timeline.video[index].transitionIn.kind !== "cut" && priorEnd <= start);
  })) return "RENDER_FRAME_RANGE";
  return null;
}

export const comicRenderRequestSchema = z.object({
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
  requestId: id.transform(value => value.toLowerCase()),
}).strict();
export const comicFrozenRenderSchema = z.object({
  schemaVersion: z.literal(1), editId: id, editRevision: z.number().int().positive(), timeline: comicTimelineSchema,
}).strict();
export type ComicFrozenRenderInput = z.infer<typeof comicFrozenRenderSchema>;
export type ComicRenderRequest = z.infer<typeof comicRenderRequestSchema>;
export type ComicRender = {
  id: string; editId: string; editRevision: number; durationMs: number;
  status: "pending" | "running" | "ready" | "failed" | "cancelled"; error: string | null; mediaId: string | null;
  title: string | null; createdAt: string; recoverable: boolean;
};
export type ComicRenderHistory = { entries: ComicRender[]; nextCursor: string | null };
export type ComicRenderDownload = { url: string; filename: string };

/** Compute clip-anchored SFX timeline blocks from per-shot sfxRefs and legacy card-level sfxRefs. */
export function planClipSfxPlacements(
  draft: Pick<ComicDramaClipDraft, "shots" | "sfxRefs">,
  videoItemId: string,
  videoDurationMs: number,
  mediaDurations: ReadonlyMap<string, number>,
  makeId: () => string,
): ComicTimeline["sfx"] {
  if (videoDurationMs <= 0) return [];
  const items: ComicTimeline["sfx"] = [];
  const maxOffset = Math.max(0, videoDurationMs - 1);
  let cumulativeShare = 0;

  for (const shot of draft.shots) {
    const shotStartMs = Math.min(maxOffset, Math.round((videoDurationMs * cumulativeShare) / 100));
    const nextShare = Math.min(100, cumulativeShare + shot.durationShare);
    const shotEndMs = Math.min(videoDurationMs, Math.round((videoDurationMs * nextShare) / 100));
    const shotDurationMs = Math.max(1, shotEndMs - shotStartMs);
    cumulativeShare = nextShare;
    for (const ref of shot.sfxRefs ?? []) {
      const sourceDurationMs = mediaDurations.get(ref.mediaId);
      if (!sourceDurationMs || sourceDurationMs <= 0) continue;
      let intraOffsetMs = 0;
      if (typeof ref.offsetMs === "number") {
        intraOffsetMs = Math.min(Math.max(0, ref.offsetMs), Math.max(0, shotDurationMs - 1));
      } else if (ref.position === "middle") {
        intraOffsetMs = Math.floor(shotDurationMs / 2);
      } else if (ref.position === "end") {
        intraOffsetMs = Math.max(0, shotDurationMs - Math.min(sourceDurationMs, shotDurationMs));
      }
      const offsetMs = Math.min(maxOffset, Math.max(0, shotStartMs + intraOffsetMs));
      const durationMs = Math.max(1, Math.min(sourceDurationMs, videoDurationMs - offsetMs));
      items.push({
        id: makeId(),
        mediaId: ref.mediaId,
        anchor: { kind: "clip", videoItemId, offsetMs },
        durationMs,
        sourceInMs: 0,
        volume: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
        loop: false,
      });
    }
  }

  for (const ref of draft.sfxRefs ?? []) {
    const sourceDurationMs = mediaDurations.get(ref.mediaId);
    if (!sourceDurationMs || sourceDurationMs <= 0) continue;
    items.push({
      id: makeId(),
      mediaId: ref.mediaId,
      anchor: { kind: "clip", videoItemId, offsetMs: 0 },
      durationMs: Math.max(1, Math.min(sourceDurationMs, videoDurationMs)),
      sourceInMs: 0,
      volume: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
      loop: false,
    });
  }

  return items;
}

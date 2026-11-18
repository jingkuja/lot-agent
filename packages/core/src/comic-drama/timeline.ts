import { z } from "zod";

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
  id, mediaId: id, anchor, durationMs: ms.min(1), sourceInMs: ms, volume,
  fadeInMs: ms, fadeOutMs: ms, loop: z.boolean(),
}).strict();
const subtitle = z.object({ id, anchor, durationMs: ms.min(1), text: z.string().trim().min(1).max(2000) }).strict();

export const comicTimelineSchema = z.object({
  schemaVersion: z.literal(1), aspectRatio: z.enum(["9:16", "16:9", "1:1"]),
  video: z.array(video), voice: z.array(audio), sfx: z.array(audio), music: z.array(audio), subtitles: z.array(subtitle),
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

export const comicRenderRequestSchema = z.object({ expectedRevision: z.number().int().positive(), requestId: id }).strict();
export const comicFrozenRenderSchema = z.object({
  schemaVersion: z.literal(1), editId: id, editRevision: z.number().int().positive(), timeline: comicTimelineSchema,
}).strict();
export type ComicFrozenRenderInput = z.infer<typeof comicFrozenRenderSchema>;

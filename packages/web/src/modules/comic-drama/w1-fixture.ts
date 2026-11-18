import { COMIC_DRAMA_ROOT, type ComicDramaClip, type ComicDramaSeries } from "@lot-agent/core/comic-drama";

const series: ComicDramaSeries = {
  id: "4c8c9f0f-1f87-4efa-9b18-ba6e266a67ca",
  parentId: null,
  title: "末世便利店 第 3 集",
  logline: "林夏在雨夜找到一间仍在营业的便利店。",
  seriesGroup: "末世便利店",
  episodeNo: 3,
  styleKey: "thick_painting",
  aspectRatio: "9:16",
  videoModel: "kling-video-v3-omni",
  revision: 4,
  archivedAt: null,
};

const clips: ComicDramaClip[] = [{
  id: "9d589f4a-0ade-43c4-8150-72aee6458e94",
  revision: 1,
  ordinal: 1,
  draft: {
    schemaVersion: 1,
    durationMs: 6000,
    scene: "雨夜便利店门外",
    shots: [{
      id: "0f113c18-46bf-40ec-8a4b-098b97380602",
      framingKey: "wide",
      movementKey: "push",
      description: "林夏举起手电，走进便利店。",
      durationShare: 100,
    }],
    lines: [],
  },
}, {
  id: "e3d6672b-9a08-4aa5-8bbf-148c89fce639",
  revision: 2,
  ordinal: 2,
  draft: {
    schemaVersion: 1,
    durationMs: 8000,
    scene: "柜台相遇",
    shots: [{
      id: "237e8ffc-22ba-4186-a3db-14e7fbaf6646",
      framingKey: "close_up",
      movementKey: "fixed",
      description: "老周扶着柜台站起，手电光落在脸上。",
      durationShare: 100,
    }],
    lines: [{
      id: "9a238ce6-e160-46a7-9341-583e7f85aedc",
      speaker: "老周",
      text: "欢迎光临，营业时间到凌晨三点。",
      emotionKey: "calm",
      speed: 1,
    }],
  },
}];

// Fixture only. The W1 milestone does not mount these views in ProductShell.
export const comicDramaW1Fixture = {
  workspace: { href: COMIC_DRAMA_ROOT + "/series/" + series.id, series, clips },
  create: { dialog: "new-series", title: "末世便利店 第 4 集", previousSeriesId: series.id },
  history: { href: COMIC_DRAMA_ROOT + "/series", entries: [series], nextCursor: null },
  characters: { href: COMIC_DRAMA_ROOT + "/characters", entries: [{ name: "林夏", outfit: "末世装" }, { name: "老周", outfit: "店主围裙" }] },
  materials: { href: COMIC_DRAMA_ROOT + "/materials", entries: [{ name: "便利店柜台", kind: "scene" }, { name: "雨夜环境", kind: "sound" }] },
  versions: {
    href: COMIC_DRAMA_ROOT + "/clips",
    entries: [{ clipId: clips[1].id, version: 1, adopted: false }, { clipId: clips[1].id, version: 2, adopted: true }],
  },
  editor: {
    href: COMIC_DRAMA_ROOT + "/editor",
    timeline: [
      { clipId: clips[0].id, version: 2, inMs: 0, outMs: 6000 },
      { clipId: clips[1].id, version: 1, inMs: 400, outMs: 7600 },
    ],
  },
  errors: {
    staleSave: { status: 409, body: { code: "REVISION_CONFLICT", currentRevision: clips[1].revision } },
    missingSeries: { status: 404, body: { code: "NOT_FOUND" } },
    retryableLoad: { status: 503, body: { code: "TEMPORARILY_UNAVAILABLE" } },
  },
} as const;

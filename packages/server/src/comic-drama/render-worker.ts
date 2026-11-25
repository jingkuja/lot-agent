import type { Pool } from "pg";
import { withComicGenerationLock } from "./generation-worker.js";
import { ComicLibraryError } from "./library-db.js";
import type { ComicMediaLibrary } from "./media-library.js";
import { ComicRenderFailure, composeComicRender, type ComicRenderSource } from "./render-media.js";
import { PgComicRenders } from "./render-repository.js";

export async function runComicRender(
  pool: Pool,
  media: ComicMediaLibrary,
  job: { id: string; userId: string },
  signal: AbortSignal,
  heartbeat?: () => void,
) {
  return withComicGenerationLock(pool, job.id, async () => {
    const repo = new PgComicRenders(pool);
    const owner = job.userId;
    try {
      const { frozen, takes, inputs, mediaId } = await repo.work(owner, job.id);
      if (mediaId) return { mediaId };
      media.assertAvailable();
      const retained = new Set(inputs);
      const videos = new Map<string, ComicRenderSource>(), audio = new Map<string, ComicRenderSource>();
      for (const clip of frozen.timeline.video) {
        const id = takes?.[clip.takeId];
        if (!id || !retained.has(id)) throw new ComicRenderFailure("RENDER_SOURCE_UNAVAILABLE");
        if (!videos.has(clip.takeId)) videos.set(clip.takeId, await media.renderSource(owner, id, "video"));
      }
      for (const track of ["voice", "music", "sfx"] as const) {
        for (const clip of frozen.timeline[track]) {
          if (!retained.has(clip.mediaId)) throw new ComicRenderFailure("RENDER_SOURCE_UNAVAILABLE");
          if (!audio.has(clip.mediaId)) audio.set(clip.mediaId, await media.renderSource(owner, clip.mediaId, "audio"));
        }
      }
      const film = await composeComicRender(frozen.timeline, { videos, audio }, signal, {
        fpsMode: frozen.fpsMode ?? "auto",
        onHeartbeat: heartbeat,
        mediaRoot: media.rootDir,
      });
      try { return await media.publishRender(owner, film.file, signal, file => repo.complete(job.id, file, signal, film.outputFps)); }
      finally { await film.dispose(); }
    } catch (error) {
      signal.throwIfAborted();
      const code = error instanceof ComicRenderFailure ? error.errorCode : error instanceof ComicLibraryError ? error.code : "RENDER_FAILED";
      throw new ComicRenderFailure(code);
    }
  });
}

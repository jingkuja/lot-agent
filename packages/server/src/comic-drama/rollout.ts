import { comicDramaIdSchema } from "@lot-agent/core/comic-drama";
import { ComicLibraryError } from "./library-db.js";

export function comicRollout(env: NodeJS.ProcessEnv = process.env) {
  const values = env.COMIC_DRAMA_PILOT_OWNER_IDS?.trim();
  const owners = values ? new Set(values.split(",").flatMap(value => {
    const id = comicDramaIdSchema.safeParse(value.trim());
    return id.success ? [id.data] : [];
  })) : null;
  const enabled = env.COMIC_DRAMA_FACTORY === "1";
  const admits = (owner?: string) => enabled && (!owners || !!owner && owners.has(owner.toLowerCase()));
  return {
    enabled, personalized: !!owners, admits,
    showEntry: (owner?: string) => admits(owner) && env.COMIC_DRAMA_ENTRY_HIDDEN !== "1",
    accepting() {
      if (env.COMIC_DRAMA_WRITES_PAUSED === "1") throw new ComicLibraryError("COMIC_SUBMISSIONS_PAUSED", 503);
    },
  };
}

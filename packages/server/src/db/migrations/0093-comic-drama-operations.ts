import type { Migration } from "../migration-runner.js";

export const comicDramaOperations: Migration = {
  version: 93, name: "comic-drama-operations",
  async up(db) {
    await db.query(`
      CREATE TABLE lot_comic_drama.cd_task_recoveries (
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        happened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX cd_task_recovery_time ON lot_comic_drama.cd_task_recoveries(happened_at);
      CREATE FUNCTION lot_comic_drama.track_task_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO lot_comic_drama.cd_task_recoveries(task_id) VALUES (NEW.id);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER cd_track_task_recovery AFTER UPDATE OF status ON tasks FOR EACH ROW
        WHEN (NEW.type IN ('comic-drama.image','comic-drama.video','comic-drama.render') AND NEW.status='pending' AND OLD.status<>'pending')
        EXECUTE FUNCTION lot_comic_drama.track_task_recovery();
    `);
  },
};

import type { Migration } from "../migration-runner.js";

/** Queue wait and run time for operations metrics. Task status is written from many places,
 * so a trigger keeps the times: `started_at` is the first claim (queue wait = started_at −
 * created_at), `run_started_at` the latest one after a resume, and `finished_at` the entry
 * into a terminal status, cleared when a task is resumed. Rows from before this migration
 * have no times; rows inserted already finished (reused clips) never get a start. */
export const taskTiming: Migration = {
  version: 59, name: "task-timing",
  async up(client) {
    await client.query(`ALTER TABLE tasks ADD COLUMN started_at TIMESTAMPTZ,
        ADD COLUMN run_started_at TIMESTAMPTZ, ADD COLUMN finished_at TIMESTAMPTZ;
      CREATE FUNCTION tasks_track_timing() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'running' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'running') THEN
          NEW.started_at := COALESCE(NEW.started_at, now());
          NEW.run_started_at := now();
        END IF;
        IF NEW.status NOT IN ('succeeded','failed','cancelled') THEN
          NEW.finished_at := NULL;
        ELSIF TG_OP = 'INSERT' OR OLD.status NOT IN ('succeeded','failed','cancelled') THEN
          NEW.finished_at := now();
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER tasks_track_timing BEFORE INSERT OR UPDATE OF status ON tasks
        FOR EACH ROW EXECUTE FUNCTION tasks_track_timing();
      CREATE INDEX tasks_type_created ON tasks(type, created_at);`);
  },
};

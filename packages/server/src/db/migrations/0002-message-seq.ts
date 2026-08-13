import type { Migration, QueryClient } from "../migration-runner.js";

/**
 * Report #20 (ordering half): messages are read back with
 * `ORDER BY created_at ASC`, but `created_at` is a `TIMESTAMPTZ` — two rows
 * written in the same millisecond (parallel tool results, concurrent writes)
 * sort in storage order, not intent order, and the model's next turn can see
 * its own tool call/result pair reversed. This migration adds a
 * conversation-scoped, monotonically increasing `seq` on `messages` and a
 * `next_seq` counter on `conversations` to hand them out, then switches every
 * messages-ordering read to `(conversation_id, seq)`.
 *
 * Runs inside the migration runner's per-migration transaction (do not BEGIN/
 * COMMIT/ROLLBACK here).
 */
async function up(client: QueryClient): Promise<void> {
  await client.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq BIGINT;
  `);
  await client.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS next_seq BIGINT NOT NULL DEFAULT 0;
  `);

  // Backfill existing rows (idempotent: `WHERE m.seq IS NULL` makes a re-run a
  // no-op). The window function ranks ALL rows in the table (not just the
  // NULL ones — `row_number() OVER (...)` can't be scoped to a WHERE-filtered
  // subset without shifting the numbering), but the outer UPDATE only ever
  // writes seq into rows where it is still NULL. This migration only ever
  // sees two states in practice: (a) a first run on a pre-existing database,
  // where every row's seq is NULL, so `ranked.rn` is exactly the backfill
  // sequence and gets written everywhere; or (b) a re-run after (a) already
  // completed, where every row already has a non-NULL seq, so the `WHERE
  // m.seq IS NULL` predicate matches zero rows and the statement is a no-op.
  // A mixed state (some rows NULL, some already seq'd) is not a state this
  // migration itself can produce and isn't expected to occur — but even if it
  // did, `ranked.rn` is computed from `row_number()` over the *whole* table,
  // so it never collides with an already-assigned seq range on a given
  // conversation_id; it's a superset of what a from-scratch backfill would
  // assign, restricted to the still-NULL subset.
  await client.query(`
    UPDATE messages m SET seq = ranked.rn
    FROM (
      SELECT id, row_number() OVER (PARTITION BY conversation_id ORDER BY created_at ASC, id ASC) AS rn
      FROM messages
    ) ranked
    WHERE m.id = ranked.id AND m.seq IS NULL;
  `);

  // Point next_seq at the current max so the first live INSERT after this
  // migration allocates max+1, not 1 (which could collide with a backfilled row).
  await client.query(`
    UPDATE conversations c SET next_seq = COALESCE(
      (SELECT MAX(seq) FROM messages WHERE conversation_id = c.id), 0);
  `);

  // The backfill above always runs before this index is created, so the
  // "every row already has a distinct seq" precondition holds by the time the
  // uniqueness constraint is enforced. (Postgres unique indexes treat NULLs
  // as pairwise non-conflicting anyway, so even a hypothetical leftover NULL
  // row would not fail index creation.)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages (conversation_id, seq);
  `);
}

export const messageSeq: Migration = {
  version: 2,
  name: "message-seq",
  up,
};

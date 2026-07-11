import type { Migration, QueryClient } from "../migration-runner.js";

/**
 * Report #20 (concurrency half) / architecture #10: two tabs/devices sending
 * into the SAME conversation at once had no server-side guard — messages
 * interleaved and both turns wrote history concurrently. This adds a simple
 * run lease on `conversations`: `active_run_id` holds the UUID of whichever
 * request currently "owns" the conversation's turn, `run_started_at` its
 * claim time. `DB.claimConversationRun` / `releaseConversationRun` (added in
 * database.ts) do the atomic CAS + fencing; no queueing — a caller that loses
 * the race gets a 409 immediately (see routes/conversations.ts).
 *
 * Runs inside the migration runner's per-migration transaction (do not BEGIN/
 * COMMIT/ROLLBACK here).
 */
async function up(client: QueryClient): Promise<void> {
  await client.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS active_run_id UUID;
  `);
  await client.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS run_started_at TIMESTAMPTZ;
  `);
}

export const conversationRunLease: Migration = {
  version: 3,
  name: "conversation-run-lease",
  up,
};

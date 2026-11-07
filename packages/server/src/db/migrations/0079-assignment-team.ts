import type { Migration } from "../migration-runner.js";

/**
 * Subtasks are addressed by their position in the tree, so a model never handles an id. Status entries also
 * carry a code: their title is written for models, and the interface words them in the owner's language.
 */
export const assignmentTeam: Migration = {
  version: 79, name: "assignment-team",
  async up(client) {
    await client.query(`
      ALTER TABLE de_assignment_board ADD COLUMN IF NOT EXISTS event TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_de_assignments_position ON de_assignments (root_id, position);
      CREATE INDEX IF NOT EXISTS idx_de_assignments_waiting ON de_assignments (root_id) WHERE status IN ('waiting_team', 'waiting_children');
    `);
  },
};

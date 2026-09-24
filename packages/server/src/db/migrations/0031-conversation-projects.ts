import type { Migration } from "../migration-runner.js";

export const conversationProjects: Migration = {
  version: 31,
  name: "conversation-projects",
  async up(client) {
    await client.query(`
      CREATE TABLE conversation_projects (
        id TEXT PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        name VARCHAR(80) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (id, user_id)
      );
      ALTER TABLE conversations ADD COLUMN project_id TEXT;
      ALTER TABLE conversations ADD CONSTRAINT conversations_project_owner_fk
        FOREIGN KEY (project_id, user_id) REFERENCES conversation_projects(id, user_id);
      CREATE INDEX conversations_project_idx ON conversations(user_id, project_id);
    `);
  },
};

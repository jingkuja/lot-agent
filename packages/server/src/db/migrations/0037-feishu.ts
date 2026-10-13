import type { Migration } from "../migration-runner.js";

export const feishuIntegration: Migration = {
  version: 37, name: "feishu-integration",
  async up(client) {
    await client.query(`
      CREATE TABLE feishu_connections (
        user_id VARCHAR(100) PRIMARY KEY, app_id TEXT NOT NULL, open_id TEXT NOT NULL,
        tenant_key TEXT NOT NULL, name TEXT NOT NULL,
        access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at DOUBLE PRECISION NOT NULL,
        scopes JSONB NOT NULL, revision UUID NOT NULL,
        UNIQUE(app_id, tenant_key, open_id)
      );
      CREATE TABLE feishu_oauth_states (
        state_hash TEXT PRIMARY KEY, user_id VARCHAR(100) NOT NULL,
        verifier TEXT NOT NULL, app_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX feishu_oauth_owner ON feishu_oauth_states(user_id);
      CREATE TABLE feishu_contacts (
        user_id VARCHAR(100) NOT NULL, alias TEXT NOT NULL, open_id TEXT NOT NULL,
        PRIMARY KEY(user_id, alias)
      );
      CREATE TABLE feishu_sends (
        user_id VARCHAR(100) NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sending','sent','failed','unknown')),
        message_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(user_id, request_id)
      );
      CREATE TABLE feishu_inbox (
        message_id TEXT PRIMARY KEY, user_id VARCHAR(100) NOT NULL, revision UUID NOT NULL,
        text TEXT NOT NULL, chat_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ
      );
      CREATE INDEX feishu_inbox_pending ON feishu_inbox(created_at) WHERE status='pending';
      CREATE INDEX feishu_inbox_owner ON feishu_inbox(user_id,created_at DESC);
    `);
  },
};

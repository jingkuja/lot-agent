import type { Migration } from "../migration-runner.js";

export const agentRunState: Migration = {
  version: 34,
  name: "agent-run-state",
  async up(client) {
    await client.query(`
      CREATE TABLE agent_runs (
        id UUID PRIMARY KEY,
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id VARCHAR(100) NOT NULL,
        source_message_id UUID,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        state JSONB NOT NULL DEFAULT '{}',
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ
      );
      CREATE INDEX agent_runs_conversation_idx ON agent_runs(conversation_id, started_at DESC);
      CREATE TABLE agent_steps (
        id UUID PRIMARY KEY,
        run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        iteration INTEGER NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        effect TEXT NOT NULL CHECK (effect IN ('read','write','interaction')),
        input JSONB NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','unknown_outcome')),
        result JSONB,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        UNIQUE(run_id, iteration, tool_call_id)
      );
      CREATE INDEX agent_steps_unresolved_idx ON agent_steps(tool_name, input_hash)
        WHERE effect = 'write' AND status IN ('running','unknown_outcome');
    `);
  },
};

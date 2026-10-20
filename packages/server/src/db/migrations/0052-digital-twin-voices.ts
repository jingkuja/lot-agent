import type { Migration } from "../migration-runner.js";

export const digitalTwinVoices: Migration = {
  version: 52, name: "digital-twin-voices",
  async up(client) {
    await client.query(`CREATE TABLE digital_twin_voices (
      owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id UUID NOT NULL,
      revision_id UUID NOT NULL,
      target_model TEXT NOT NULL,
      credential_scope TEXT NOT NULL,
      prefix VARCHAR(10) NOT NULL UNIQUE,
      voice_id TEXT,
      status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','DEPLOYING','OK','UNDEPLOYED')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id,item_id,revision_id),
      FOREIGN KEY (owner_id,item_id,revision_id) REFERENCES rag_item_revisions(owner_id,item_id,id) ON DELETE CASCADE
    )`);
  },
};

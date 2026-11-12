import type { Migration } from "../migration-runner.js";

export const imageCallReceipts: Migration = {
  version: 82, name: "image-call-receipts",
  async up(client) {
    await client.query(`CREATE TABLE image_call_receipts (
      task_id UUID NOT NULL REFERENCES tasks(id), user_id TEXT NOT NULL, slot INTEGER NOT NULL CHECK (slot >= 0),
      fingerprint TEXT NOT NULL, claim_id UUID NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('submitting','submitted','completed','failed','unknown')),
      vendor_id TEXT, result JSONB, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(task_id, slot)
    )`);
  },
};

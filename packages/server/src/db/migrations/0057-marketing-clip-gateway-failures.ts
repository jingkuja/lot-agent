import type { Migration } from "../migration-runner.js";

/** Clip submissions the gateway answered with a 5xx. They count as not charged and the clip
 * is resubmitted on the next continue; the gateway request ID matches a rare real charge in
 * the gateway logs for a refund. Identifiers only, kept after the draft is deleted. */
export const marketingClipGatewayFailures: Migration = {
  version: 57, name: "marketing-clip-gateway-failures",
  async up(client) {
    await client.query(`CREATE TABLE marketing_clip_gateway_failures (
        id BIGSERIAL PRIMARY KEY,
        owner_id VARCHAR(100) NOT NULL,
        project_id UUID NOT NULL,
        task_id UUID NOT NULL,
        http_status INTEGER NOT NULL,
        gateway_request_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX marketing_clip_gateway_failures_created ON marketing_clip_gateway_failures(created_at);`);
  },
};

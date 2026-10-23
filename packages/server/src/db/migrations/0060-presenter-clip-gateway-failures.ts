import type { Migration } from "../migration-runner.js";

/** Digital presenter clip submissions the gateway answered with a 5xx, as migration 57 does
 * for marketing clips: they count as not charged and the clip is resubmitted on the next
 * continue; the gateway request ID matches a rare real charge in the gateway logs. */
export const presenterClipGatewayFailures: Migration = {
  version: 60, name: "presenter-clip-gateway-failures",
  async up(client) {
    await client.query(`CREATE TABLE digital_presenter_clip_gateway_failures (
        id BIGSERIAL PRIMARY KEY,
        owner_id VARCHAR(100) NOT NULL,
        project_id UUID NOT NULL,
        task_id UUID NOT NULL,
        slot INTEGER NOT NULL,
        model TEXT NOT NULL,
        http_status INTEGER NOT NULL,
        gateway_request_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX digital_presenter_clip_gateway_failures_created ON digital_presenter_clip_gateway_failures(created_at);`);
  },
};

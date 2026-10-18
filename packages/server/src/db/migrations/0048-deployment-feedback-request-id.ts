import type { Migration } from "../migration-runner.js";

export const deploymentFeedbackRequestId: Migration = {
  version: 48, name: "deployment-feedback-request-id",
  async up(client) {
    await client.query(`
      ALTER TABLE de_deployment_feedback ADD COLUMN request_id UUID;
      CREATE UNIQUE INDEX de_deployment_feedback_request
        ON de_deployment_feedback (user_id, deployment_id, request_id) WHERE request_id IS NOT NULL;
    `);
  },
};

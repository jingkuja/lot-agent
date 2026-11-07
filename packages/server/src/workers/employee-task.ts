import "../load-env.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretBox } from "../auth/secret-box.js";
import { CONVERSATION_STALE_MS, AssignmentRunner } from "../digital-employee/assignment-runner.js";
import { DIGITAL_EMPLOYEE_AGENT_ID } from "../digital-employee/agent.js";
import { digitalEmployeeAssignmentsEnabled } from "../digital-employee/feature-scope.js";
import { isFeishuEnabled } from "../feishu/client.js";
import { PgFeishuRepository } from "../feishu/repository.js";
import { FeishuService } from "../feishu/service.js";
import { AgentService } from "../services/agent-service.js";
import { loadServiceConfig } from "../services/service-config.js";
import { internationalModelsEnabled } from "../tokenhub/model-access.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// {src,dist}/workers/ → repo root is 4 levels up.
const ROOT = resolve(__dirname, "../../../..");
/** Well under the container's stop period, so turns end on our terms. */
const SHUTDOWN_GRACE_MS = Number(process.env.ASSIGNMENT_SHUTDOWN_GRACE_MS) || 40_000;

/**
 * Long tasks run here so they do not compete with chat for the API's resources, and so the API can restart
 * without stopping them. It builds the same AgentService as the API, which gives it the same tools.
 */
async function main() {
  // A disabled service keeps running idle: exiting would have the restart policy loop it.
  if (!digitalEmployeeAssignmentsEnabled()) {
    console.log("[assignments] DIGITAL_EMPLOYEE_ASSIGNMENTS is off; idle");
    const idle = setInterval(() => {}, 3_600_000);
    const quit = () => { clearInterval(idle); process.exit(0); };
    process.once("SIGINT", quit);
    process.once("SIGTERM", quit);
    return;
  }

  const config = await loadServiceConfig(ROOT);
  const service = new AgentService({ ...config, db: { ...config.db, max: Number(process.env.PG_POOL_MAX) || undefined } });
  // The API owns migrations and MCP connections.
  await service.init({ background: true });

  // Deliberately not assigned to service.feishuService: that would hand Feishu tools to the turn.
  const feishu = isFeishuEnabled() ? new FeishuService(new PgFeishuRepository(service.db.pool), new SecretBox(process.env.SECRET_MASTER_KEY)) : null;
  const assignments = service.digitalEmployee.assignments;
  const runner = new AssignmentRunner(assignments.repository, {
    claimConversation: (conversationId, runId) => service.db.claimConversationRun(conversationId, runId, CONVERSATION_STALE_MS),
    renewConversation: (conversationId, runId) => service.db.renewConversationRun(conversationId, runId),
    releaseConversation: (conversationId, runId) => service.db.releaseConversationRun(conversationId, runId),
    stream: ({ conversationId, message, userId, attachments, signal, runId, modelId, beforeIteration }) =>
      service.streamAgentResponse(conversationId, message, DIGITAL_EMPLOYEE_AGENT_ID, userId, attachments, signal, { runId, modelId, beforeIteration }),
    generateTitle: ({ conversationId, goal, attachments, userId }) =>
      service.generateTitle(conversationId, goal, attachments, { userId, agentId: DIGITAL_EMPLOYEE_AGENT_ID }),
    summarize: (input) => service.summarizeAssignment(input),
    employeeName: async (userId) => (await service.digitalEmployee.settings.get(userId)).employeeName,
    sendToOwner: feishu ? (userId, message) => feishu.send(userId, { recipient: "self", ...message }) : undefined,
    english: internationalModelsEnabled(),
  });
  runner.start();
  console.log("[assignments] worker started");

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await runner.stop(SHUTDOWN_GRACE_MS);
    await service.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Failed to start employee task worker:", error);
  process.exit(1);
});

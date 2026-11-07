import type { Tool } from "@lot-agent/core";
import type { AssignmentMode } from "./assignment-state.js";
import { object, toolError } from "./tools/agent-tool-helpers.js";

export const BACKGROUND_TASK_TOOL = "start_background_task";

const MAX_GOAL = 8_000;
const MAX_SUBTASKS = 20;

/** Only in chat. A task turn cannot start another task: it has create_subtasks. */
export const BACKGROUND_TASK_RULES = `[Background tasks]
When the owner wants something done in the background, while they are away, or to hear back when it is finished, such as "放后台做", "你慢慢做，做完告诉我" or "do this in the background", call ${BACKGROUND_TASK_TOOL} as your first tool, before searching or reading anything: looking things up is part of the task, and the task does it. Do not use it for anything else: a normal request is done in this conversation, however long it looks.
- The task runs in its own conversation and cannot see this one. Put everything it needs in goal: what the owner asked, in their words, and what was already settled here.
- Leave mode out unless the owner says not to ask them, which is autonomous.
- Afterwards tell the owner in one or two lines that it has started, keep the link, and stop.`;

/** Full autonomy may write without asking, so it takes the owner's own words. Negated forms do not count. */
const GRANTS_AUTONOMY = new RegExp([
  "(?<!要|想|得)(?:不用|不必|无需|别|不要)(?:再)?(?:来)?(?:问|请示|打扰|确认)",
  "(?<!不要|不用|别|不能)(?:你)?自己(?:决定|看着办|拿主意|做主)",
  "全权", "完全自主", "don'?t (?:ask|check with) me", "do not (?:ask|check with) me", "without asking", "your (?:own )?call", "fully autonomous",
].join("|"), "iu");

/** The model only proposes a mode. What it can do unattended follows from what the owner typed, not from a tool argument. */
export function chatTaskMode(requested: unknown, ownerText: string | undefined): AssignmentMode {
  return requested === "autonomous" && GRANTS_AUTONOMY.test(ownerText ?? "") ? "autonomous" : "responsive";
}

export interface ChatTaskStarter {
  startFromChat(userId: string, conversationId: string, input: { goal: string; mode: AssignmentMode; subtasks: string[] }):
    Promise<{ id: string; title: string; mode: AssignmentMode; status: string }>;
}

export function createBackgroundTaskTool(starter: ChatTaskStarter): Tool {
  return {
    name: BACKGROUND_TASK_TOOL,
    description: "Hand a job to yourself to do in the background, so the owner can leave. It starts at once, and the owner is told when it ends or needs them. " +
      "Files on the owner's latest message go with it. It cannot see this conversation, so goal must stand on its own.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The complete job, including what was settled in this conversation." },
        subtasks: { type: "array", items: { type: "string" }, maxItems: MAX_SUBTASKS, description: "Only if the owner listed separate parts." },
        mode: { type: "string", enum: ["responsive", "autonomous"], description: "autonomous only if the owner said not to ask them." },
      },
      required: ["goal"],
    },
    async execute(input, context) {
      try {
        const value = object(input);
        const goal = typeof value.goal === "string" ? value.goal.trim().slice(0, MAX_GOAL) : "";
        if (!goal) return { content: `${BACKGROUND_TASK_TOOL} needs a goal.`, isError: true, errorKind: "validation" };
        if (!context.userId || !context.conversationId) return { content: "Background tasks are not available here.", isError: true, errorKind: "permission" };
        const listed: unknown[] = Array.isArray(value.subtasks) ? value.subtasks : [];
        const subtasks = listed.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
          .map((item) => item.trim().slice(0, MAX_GOAL)).slice(0, MAX_SUBTASKS);
        const mode = chatTaskMode(value.mode, context.sourceText);
        const task = await starter.startFromChat(context.userId, context.conversationId, { goal, mode, subtasks });
        return {
          content: JSON.stringify({
            title: task.title, mode: task.mode, status: task.status, managementUrl: `/digital-employee/assignments/${task.id}`,
            next: "It is running. Tell the owner briefly, with a link to managementUrl. Do not do the work here.",
          }),
        };
      } catch (error) {
        return toolError("后台任务没有建成", error);
      }
    },
  };
}

import type { Tool } from "@lot-agent/core";
import { InputError } from "../errors.js";
import { object, optionalString, toolError } from "./agent-tool-helpers.js";

const TOPIC_MAX = 800;
const RATIOS = ["9:16", "16:9", "1:1"] as const;
type Ratio = typeof RATIOS[number];

/** The studio belongs to another agent, so the module only knows this port. */
export interface MarketingVideoDrafts {
  create(userId: string, input: { requestKey: string; topic: string; durationSec?: number; ratio?: Ratio }): Promise<{ projectId: string; reused: boolean }>;
}

export function marketingVideoStudioPath(projectId: string): string {
  return `/assistant?agent=marketing_video&project=${encodeURIComponent(projectId)}`;
}

function duration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 15 || (value as number) > 60) throw new InputError("durationSec必须是 15 到 60 的整数");
  return value as number;
}

function ratio(value: unknown): Ratio | undefined {
  if (value === undefined) return undefined;
  if (!RATIOS.includes(value as Ratio)) throw new InputError("ratio无效");
  return value as Ratio;
}

export function createMarketingVideoTools(
  drafts: MarketingVideoDrafts,
  assertGroupContent: (userId: string, fields: Record<string, string | undefined>) => Promise<void>,
): Tool[] {
  const start: Tool = {
    name: "start_marketing_video",
    effect: "write",
    description:
      "Create a marketing video draft holding only the brief, and return the link that opens the four-step studio. " +
      "Use for a marketing short video or talking-presenter video. It writes no copy or storyboard and starts nothing paid: " +
      "the owner does that in the studio. generate_campaign_video is only for one clip inside a campaign.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The brief: the owner's request plus confirmed product facts from search_marketing_materials. No customer names or contact details.",
        },
        durationSec: { type: "integer", description: "Seconds, 15 to 60. Omit unless the owner stated it." },
        ratio: { type: "string", enum: [...RATIOS], description: "Omit unless the owner stated it." },
      },
      required: ["topic"],
    },
    async execute(input, context) {
      try {
        context.signal?.throwIfAborted();
        const source = object(input);
        const topic = optionalString(source.topic, TOPIC_MAX, "topic");
        if (!topic) throw new InputError("topic不能为空");
        if (!context.userId) throw new InputError("缺少用户");
        // The video is public, so the brief obeys the same rule as any group content.
        await assertGroupContent(context.userId, { 视频需求: topic });
        const { projectId, reused } = await drafts.create(context.userId, {
          requestKey: `${context.conversationId}:${context.sourceMessageId}:${topic}`,
          topic,
          durationSec: duration(source.durationSec),
          ratio: ratio(source.ratio),
        });
        return {
          content: JSON.stringify({
            projectId,
            reused,
            managementUrl: marketingVideoStudioPath(projectId),
            notPerformed: "No copy, storyboard, cost confirmation or submission. The owner continues in the studio.",
          }),
        };
      } catch (error) {
        return toolError("创建营销影像草稿失败", error);
      }
    },
  };
  return [start];
}

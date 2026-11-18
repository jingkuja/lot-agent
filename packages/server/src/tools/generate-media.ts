import { randomUUID } from "node:crypto";
import { estimateCost, GROK_VIDEO_MODEL, type Tool, type ToolResult } from "@lot-agent/core";
import { makePricingLookup } from "../billing/pricing-lookup.js";
import { GENERATION_QUEUE_FAILED } from "../generation/errors.js";
import { finalizeImageSettings, IMAGE_RATIOS, IMAGE_RESOLUTION_PIXELS } from "../generation/input.js";
import type { AgentService } from "../services/agent-service.js";
import { agentExtension } from "../services/agent-extensions.js";

const DEFAULT_IMAGE_MODEL = "gpt-image-2.5-flare";
const VIDEO_RATIOS = ["16:9", "9:16", "1:1"];
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"];

function error(content: string, errorKind: ToolResult["errorKind"]): ToolResult {
  return { content, isError: true, errorKind };
}

export function createMediaGenerationTools(service: AgentService, publish: (id: string, type: string) => Promise<void>): Tool[] {
  return (["image", "video"] as const).map((mediaType): Tool => {
    const image = mediaType === "image";
    const type = `${mediaType}.generate`;
    return {
      name: `generate_${mediaType}`,
      effect: "write",
      description: `Generate ${image ? "one image (default 1.5K, 1:1)" : "one short spacebunny video (default 720p, 5 seconds, 16:9)"} in this chat. ` +
        "Use only when the user explicitly asks to produce the media itself. This starts a paid background job. " +
        "Omit optional settings the user did not specify. After submission, tell the user to check the generation card. " +
        "Do not say the media is finished, invent a link, or repeat an accepted or uncertain submission.",
      parameters: {
        type: "object", additionalProperties: false, required: ["prompt"],
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: 4000, description: "Instructions for the media model. Do not include private customer details." },
          ratio: { type: "string", enum: image ? [...IMAGE_RATIOS] : VIDEO_RATIOS },
          resolution: { type: "string", enum: image ? Object.keys(IMAGE_RESOLUTION_PIXELS) : VIDEO_RESOLUTIONS },
          ...(!image ? { durationSec: { type: "integer", minimum: 4, maximum: 15 } } : {}),
        },
      },
      async execute(input, { userId, conversationId, runId, signal }) {
        signal?.throwIfAborted();
        if (!userId || !conversationId || !runId) return error("此工具仅支持在已登录的对话中使用", "permission");
        const conversation = await service.db.getConversation(conversationId);
        const validateMedia = agentExtension(conversation?.agent_id)?.validateChatMedia;
        if (!conversation || conversation.user_id !== userId || conversation.channel === "feishu" ||
          (conversation.agent_id !== "general" && !validateMedia)) {
          return error("当前对话无法使用生成工具", "permission");
        }
        const args = input as { prompt: string; ratio?: string; resolution?: string; durationSec?: number };
        const prompt = args.prompt.trim();
        if (!prompt) return error("生成描述不能为空", "validation");
        const promptIssue = await validateMedia?.(userId, conversation.metadata, prompt);
        if (promptIssue) return error(promptIssue, "validation");

        const apiKey = await service.db.getUserApiKey(userId, service.managedKeysEnabled);
        if (!apiKey) return error("当前账号没有可用的模型凭证，请先配置模型", "permission");
        const catalog = await service.getUserModelCatalog(userId, apiKey);
        const imageConfig = service.generationConfig.image;
        const model = image
          ? [DEFAULT_IMAGE_MODEL, imageConfig.modelId].find(id => catalog?.image.some(item => item.id === id))
          : catalog?.video.find(item => item.id === GROK_VIDEO_MODEL)?.id;
        if (!model) return error(image ? "当前账号无法使用默认图片模型" : "当前账号无法使用 spacebunny 视频模型", "permission");

        const resolution = args.resolution ?? (image ? "1.5K" : "720p");
        const ratio = args.ratio ?? (image ? "1:1" : "16:9");
        const durationSec = args.durationSec ?? 5;
        const finalized = image ? finalizeImageSettings({ resolution, ratio, n: 1 }, model) : null;
        if (finalized?.error) return error(finalized.error, "validation");
        const settings = finalized?.settings ?? { resolution, ratio, durationSec, generate_audio: false };
        const pricing = makePricingLookup(id => service.modelRegistry.getConfig(id), service.modelCatalog, mediaType);
        const config = pricing(image ? imageConfig.modelId : model);
        const quota = await service.usageMeter.checkQuota(userId, config ? estimateCost(config, { outputCount: image ? 1 : durationSec }) : 0);
        if (!quota.ok) return error(quota.reason ?? "额度不足", "quota");

        signal?.throwIfAborted();
        const taskId = randomUUID();
        const messageId = randomUUID();
        const metadata = {
          kind: "generation", chatGeneration: true, mediaType, status: "generating", taskId, prompt, settings,
          supportsProgress: service.generationSupportsProgress[mediaType],
        };
        const job = {
          ...settings, prompt, modelId: model, conversationId, assistantMessageId: messageId, requireUserModelKey: true, chatGeneration: true,
          ...(image ? { fresh: true } : {}),
        };
        const committed = await service.db.createChatGeneration({
          taskId, messageId, conversationId, userId, runId, agentId: conversation.agent_id, type, model, job, metadata,
        });
        if (!committed) return error("对话已停止，未提交生成任务", "permission");
        try {
          signal?.throwIfAborted();
          await publish(taskId, type);
        } catch {
          if (await service.db.failUnpublishedChatGeneration(taskId, messageId, GENERATION_QUEUE_FAILED)) {
            return error(GENERATION_QUEUE_FAILED, "not_found");
          }
          return error("生成任务状态待确认，请查看对话中的生成卡片，勿重复提交", "unknown_outcome");
        }
        return { content: JSON.stringify({ status: "queued", taskId, mediaType }) };
      },
    };
  });
}

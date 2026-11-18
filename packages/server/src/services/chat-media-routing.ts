import { randomUUID } from "node:crypto";
import { isTimeoutReason, type AgentContext, type AgentEvent, type ToolCall, type ToolResult } from "@lot-agent/core";

export function chatMediaPolicy(tools: readonly string[]): string[] {
  const rules: string[] = [];
  if (tools.includes("generate_video")) {
    rules.push("When the user asks you to make a standalone video, call generate_video to submit it. " +
      "For example, ‘生成一段猫咪跳舞的视频’ is a generation request. Use the tool even though you cannot render a video yourself. " +
      "Give prompts, scripts or storyboards as text only when the user requests those deliverables.");
  }
  if (tools.includes("generate_image")) {
    rules.push("When the user asks you to make an image, call generate_image to submit it. " +
      "Writing a description or a prompt does not fulfill an image generation request.");
  }
  if (rules.length) {
    rules.push("Use tool defaults for omitted settings. Report what the tool actually did. If submission failed, explain the returned reason. " +
      "If submitted, point the user to the card. Never submit an accepted or uncertain request again.");
  }
  return rules;
}

interface DirectVideoRequest {
  language: "zh" | "en";
  args: { prompt: string; durationSec?: number; resolution?: string; ratio?: string };
}

/** Only self-contained, single-clip commands qualify for direct submission. Context-dependent requests stay with the agent. */
export function directVideoRequest(source: string): DirectVideoRequest | undefined {
  const prompt = source.trim();
  if (!prompt || prompt.length > 4000 || /[?？\n`]|https?:\/\//i.test(prompt)) return;
  const text = prompt.normalize("NFKC");
  const zh = /^(?:(?:请|麻烦你?|帮我|给我)\s*)*(?:生成|制作|做|创建)\s*(.+)$/.exec(text);
  const en = /^(?:please\s+)?(?:generate|create|make)\s+(.+)$/i.exec(text);
  const brief = (zh ?? en)?.[1];
  if (!brief || !/视频|短片|\b(?:video|clip)\b/i.test(brief)) return;
  const differentDeliverable = /提示词|脚本|文案|分镜|封面|教程|方案|示例|文档|报告|幻灯片|图片|海报|流程/;
  const contextualBrief = /营销|广告|产品|活动|客户|品牌|数字人|口播|附件|参考|上传|根据|上一|上面|刚才|这个|这段|先不|暂不|后台|做完告诉/;
  if (differentDeliverable.test(brief) || contextualBrief.test(brief)) return;
  if (/\b(?:prompts?|scripts?|storyboards?|thumbnails?|tutorials?|documents?|reports?|images?|posters?)\b/i.test(brief)) return;
  if (/\b(?:ads?|campaigns?|marketing|product|brand|attachments?|references?)\b/i.test(brief)) return;
  if (/不要\s*(?:生成|制作|提交)|然后|之后|并且|另外|不生成|\b(?:then|don't|do not|this|above|previous)\b/i.test(brief)) return;
  if (en && /\b(?:videos|clips)\b/i.test(brief)) return;
  if (en && !/^(?:me\s+)?(?:(?:an?|one|single|short|\d+\s*[- ]?second)\s+)*(?:video|clip)\b/i.test(brief)) return;

  const durationPattern = /(?<![\d.])(\d+(?:\.\d+)?)\s*-?\s*(?:秒|seconds?\b|secs?\b|s\b)/gi;
  const resolutionPattern = /\b(\d{3,4}\s*[pi]|[1-9]\d?\s*k)\b/gi;
  const ratioPattern = /(?<!\d)(\d+)\s*:\s*(\d+)(?!\d)/g;
  const durations = [...brief.matchAll(durationPattern)];
  const resolutions = [...brief.matchAll(resolutionPattern)];
  const ratios = [...brief.matchAll(ratioPattern)];
  if (durations.length > 1 || resolutions.length > 1 || ratios.length > 1 || /[一二两三四五六七八九十半]+秒/.test(brief)) return;
  const durationSec = durations.length ? Number(durations[0][1]) : undefined;
  const resolution = resolutions[0]?.[1].toLowerCase().replace(/\s/g, "");
  const ratio = ratios.length ? `${ratios[0][1]}:${ratios[0][2]}` : undefined;
  if (durationSec !== undefined && (!Number.isInteger(durationSec) || durationSec < 4 || durationSec > 15)) return;
  if (resolution && !["480p", "720p", "1080p"].includes(resolution)) return;
  if (ratio && !["16:9", "9:16", "1:1"].includes(ratio)) return;

  const description = brief.replace(durationPattern, "").replace(resolutionPattern, "").replace(ratioPattern, "").trim();
  if (zh) {
    const firstClause = description.split(/[，,、。.!！:：;；]/, 1)[0].trim();
    if (!/(?:视频|短片)$/.test(firstClause) || /^(?:一份|一篇|一本|一张|一套|一组|若干|多[个段条]|几[个段条])/.test(firstClause)) return;
    if (/^(?:[两二三四五六七八九十]+|\d{2,}|[2-9])\s*[个段条部支]/.test(firstClause)) return;
  }
  const subject = description
    .replace(/(?:一|1)[个段条部支]|个|段|条|的|短视频|视频|短片|短|\b(?:an?|me|one|single|short|video|clip|of|about|showing|please)\b/gi, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
  if (subject.length < 2) return;
  return {
    language: zh ? "zh" : "en",
    args: { prompt, ...(durationSec && { durationSec }), ...(resolution && { resolution }), ...(ratio && { ratio }) },
  };
}

export async function* runDirectVideoTool(
  request: DirectVideoRequest, context: AgentContext, allowedToolNames: string[], signal: AbortSignal,
): AsyncIterable<AgentEvent> {
  const { journal, toolRegistry, toolContext } = context;
  const call: ToolCall = { id: `call_${randomUUID().replaceAll("-", "")}`, name: "generate_video", arguments: request.args };
  signal.throwIfAborted();
  yield { type: "tool_call", id: call.id, name: call.name, input: call.arguments };
  signal.throwIfAborted();
  const entry = await journal?.start(call, 1, "write");
  let result: ToolResult;
  if (entry?.result) {
    result = entry.result;
  } else {
    result = await toolRegistry.execute(call.name, call.arguments, { ...toolContext, operationId: entry?.operationId }, { signal, allowedToolNames });
    if (entry && journal) {
      try { await journal.finish(entry.operationId, result); }
      catch { result = { content: "Video submission could not be verified.", isError: true, errorKind: "unknown_outcome" }; }
    }
  }
  yield { type: "tool_result", toolCallId: call.id, name: call.name, output: result.content,
    isError: result.isError === true, errorKind: result.errorKind };
  const uncertain = result.errorKind === "unknown_outcome";
  if (!signal.aborted) {
    const content = request.language === "zh"
      ? uncertain ? "视频提交结果待确认，请查看生成卡片。" : result.isError ? result.content : "已提交视频生成，请查看下方生成卡片。"
      : uncertain ? "Video submission is unconfirmed. Check the generation card." : result.isError
        ? "Video could not be queued. See the tool result for details." : "Video generation was submitted. See the card below.";
    yield { type: "text", content };
  }
  const status = uncertain ? "unknown_outcome" : isTimeoutReason(signal.reason) ? "timed_out"
    : signal.aborted ? "cancelled" : result.isError ? "failed" : "completed";
  yield { type: "done", status,
    iterations: 1, llmAttempts: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedPromptTokens: 0 };
}

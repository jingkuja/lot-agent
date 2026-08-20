import type { ToolContext, ToolResult } from "@lot-agent/core";
import { InputError } from "../errors.js";
import type { ConversationActionDraft } from "../conversation-drafts.js";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("参数必须是对象");
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown, max: number, label = "文本字段"): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new InputError(`${label}无效`);
  return value.trim();
}

export function sourceContext(context: ToolContext) {
  return {
    conversationId: context.conversationId,
    sourceMessageId: context.sourceMessageId,
    sourceText: context.sourceText,
    modelId: context.modelId,
  };
}

export function assertScope(context: ToolContext, expected: string, label: string) {
  if (context.featureScope && context.featureScope !== expected) {
    throw new InputError(`当前对话不在${label}作用域，请先进入${label}对话`);
  }
}

export function confirmationContent(draft: ConversationActionDraft, commitTool: string): string {
  return (
    `需要用户确认。draftId: ${draft.id}\n` +
    `请调用 ask_user，question 必须为：${draft.question ?? "请确认本次操作"}\n` +
    `options 必须为：${JSON.stringify(draft.options)}\n` +
    `预览：${JSON.stringify(draft.preview)}\n` +
    `用户确认后再调用 ${commitTool}，只传 draftId；取消时不要提交。`
  );
}

export function toolError(prefix: string, error: unknown): ToolResult {
  return {
    content: `${prefix}：${error instanceof Error ? error.message : "服务暂时不可用"}`,
    isError: true,
    errorKind: error instanceof InputError ? "validation" : "unknown",
  };
}

export function jsonResult(value: unknown): ToolResult {
  return { content: JSON.stringify(value) };
}

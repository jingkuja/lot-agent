import type { ToolContext, ToolResult } from "@lot-agent/core";
import { classifyToolFailure } from "@lot-agent/core";
import { DigitalEmployeeError, InputError } from "../errors.js";
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
    `User confirmation required. draftId: ${draft.id}\n` +
    `Call ask_user. Translate this question into the user's language without changing its meaning: ${draft.question ?? "Please confirm this operation"}\n` +
    `Translate these options into the user's language, preserving order, meaning and candidate mapping: ${JSON.stringify(draft.options)}\n` +
    `Preview: ${JSON.stringify(draft.preview)}\n` +
    `Only after confirmation call ${commitTool} with draftId only. Do not commit on cancellation.`
  );
}

export function toolError(prefix: string, error: unknown): ToolResult {
  if (error instanceof DigitalEmployeeError) {
    return { content: `${prefix}：${error.message}`, isError: true,
      errorKind: error.status === 404 ? "not_found" : error.status === 403 ? "permission" : "validation" };
  }
  return classifyToolFailure(error, prefix);
}

export function jsonResult(value: unknown): ToolResult {
  return { content: JSON.stringify(value) };
}

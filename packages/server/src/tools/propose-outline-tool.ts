import type { Tool, ToolResult } from "@lot-agent/core";
import { PPT_DECK_SCHEMA, validateDeck, inspectDeck, type PptDeck } from "@lot-agent/core/presentation";

export const proposeOutlineTool: Tool = {
  name: "propose_outline",
  description: "Show an editable slide-by-slide plan and the agreed brief, theme and uploaded template/background settings for approval. Include finished slide content, since the confirmation button exports exactly this deck without an LLM rewrite. This ends the turn; do not generate until approval.",
  parameters: PPT_DECK_SCHEMA,
  endsTurn: true,
  async execute(input): Promise<ToolResult> {
    const error = validateDeck(input);
    if (error) return { content: `propose_outline validation failed: ${error}`, isError: true, errorKind: "validation" };
    const warnings = inspectDeck(input as PptDeck);
    return { content: "[Outline shown; waiting for approval or revisions in the next user message]" + (warnings.length ? "\n" + warnings.map(w => w.message).join("\n") : "") };
  },
};

import type { Tool, ToolResult } from "@lot-agent/core";
import { PPT_DECK_SCHEMA, validateDeck, inspectDeck, type PptDeck } from "@lot-agent/core/presentation";

export const proposeOutlineTool: Tool = {
  name: "propose_outline",
  effect: "interaction",
  description: "When the user asks to review an outline before export, show the editable slide-by-slide plan, finished content and all design settings. "
    + "This ends the turn. The confirmation button exports exactly these fields without an LLM rewrite.",
  parameters: PPT_DECK_SCHEMA,
  endsTurn: true,
  async execute(input): Promise<ToolResult> {
    const error = validateDeck(input);
    if (error) return { content: `propose_outline validation failed: ${error}`, isError: true, errorKind: "validation" };
    const warnings = inspectDeck(input as PptDeck);
    return { content: "[Outline shown; waiting for approval or revisions in the next user message]" + (warnings.length ? "\n" + warnings.map(w => w.message).join("\n") : "") };
  },
};

import type { DisplayMessage } from "../hooks/chat-reducer.js";

/** Tools that render as a user-facing confirmation card and end the turn. */
export const INTERACTIVE_TOOL_NAMES = ["ask_user", "propose_outline"];

/**
 * Names of the interactive tool calls on `messages[index]` whose execution
 * FAILED (e.g. propose_outline rejected by layout validation). The agent
 * retries after such a failure, so rendering the failed call as a live
 * confirmation card shows the user two near-identical cards; callers use this
 * to replace the failed one with a muted note.
 *
 * A call's result is the tool message(s) directly following the assistant
 * message — the scan stops at the first non-tool message (the next turn).
 */
export function failedInteractiveNames(
  messages: DisplayMessage[],
  index: number
): string[] {
  const msg = messages[index];
  const interactive = msg?.toolCalls?.filter((tc) =>
    INTERACTIVE_TOOL_NAMES.includes(tc.name)
  );
  if (!interactive?.length) return [];

  const failed = new Set<string>();
  for (let j = index + 1; j < messages.length; j++) {
    const m = messages[j];
    if (m.role !== "tool") break;
    if (m.toolResult?.isError && m.toolResult.name) failed.add(m.toolResult.name);
  }
  return interactive.map((tc) => tc.name).filter((name) => failed.has(name));
}

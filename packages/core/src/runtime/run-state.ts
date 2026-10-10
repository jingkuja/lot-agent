import type { ToolCall, ToolResult, Tool } from "../types/index.js";

export type RunStatus = "completed" | "awaiting_input" | "failed" | "cancelled" | "timed_out"
  | "budget_exhausted" | "unknown_outcome" | "empty_response" | "stalled";

/** Implemented by the server. Recording must succeed before a tool may execute. */
export interface ExecutionJournal {
  start(call: ToolCall, iteration: number, effect: NonNullable<Tool["effect"]>): Promise<{
    operationId: string;
    /** Previously completed or ambiguous operation: return it without replay. */
    result?: ToolResult;
  }>;
  finish(operationId: string, result: ToolResult): Promise<void>;
}

export type RuntimeObservation =
  | { type: "llm_start"; attempt: number; purpose: "reasoning" | "compression" }
  | { type: "llm_end"; attempt: number; failed: boolean }
  | { type: "cache_hit"; toolName: string };

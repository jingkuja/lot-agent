import type { RunStatus } from "@lot-agent/core";

export type AssignmentStatus =
  | "queued" | "running" | "succeeded" | "failed" | "waiting_user" | "waiting_team" | "waiting_children" | "cancelled" | "skipped";

export type AssignmentMode = "autonomous" | "responsive";
export type PausedReason = "quota" | "cost_limit";
/** Stable codes: the interface words them, so a raw upstream error never reaches the owner. */
export type FailureReason =
  | "blocked" | "model_failed" | "empty_response" | "stalled" | "timed_out" | "unknown_outcome" | "interrupted";

export const OPEN_STATUSES: readonly AssignmentStatus[] = ["queued", "running", "waiting_user", "waiting_team", "waiting_children"];

const TRANSITIONS: Record<AssignmentStatus, readonly AssignmentStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["queued", "succeeded", "failed", "waiting_user", "waiting_team", "waiting_children", "cancelled"],
  failed: ["queued", "skipped"],
  waiting_user: ["queued", "skipped", "cancelled"],
  waiting_team: ["queued", "cancelled"],
  waiting_children: ["queued", "cancelled"],
  succeeded: [],
  cancelled: [],
  skipped: [],
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: AssignmentStatus, readonly to: AssignmentStatus) {
    super(`assignment cannot go from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Callers pair this with a version check, so an answer from two places only counts once. */
export function transitionAssignment(from: AssignmentStatus, to: AssignmentStatus): AssignmentStatus {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to);
  return to;
}

export function isOpenStatus(status: AssignmentStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export interface EndIntent {
  outcome: "done" | "blocked";
  summary: string;
  assumptions: string[];
  skipped: string[];
}

export interface TurnResult {
  /** Undefined when the run threw before the agent reported a status. */
  status: RunStatus | undefined;
  endIntent: EndIntent | null;
  /** The gateway refused for lack of balance, on the model call or in a tool. */
  quota: boolean;
  /** Set before the turn ended: the root is paused, or the owner's cost limit was hit. */
  paused: boolean;
  /** The worker is shutting down, so an aborted turn says nothing about the task. */
  shuttingDown: boolean;
  text: string;
  madeProgress: boolean;
  previousMadeProgress: boolean | null;
}

export type TurnDecision =
  | { next: "succeed"; summary: string; assumptions: string[]; skipped: string[] }
  | { next: "fail"; reason: FailureReason; summary?: string; assumptions?: string[]; skipped?: string[] }
  | { next: "pause" }
  | { next: "segment" }
  | { next: "interrupted" }
  | { next: "cancel" };

/**
 * Where a node goes after a turn, for a full-autonomy task with no subtasks yet. finish_task, wait_for_team and
 * ask_user all report awaiting_input, so what the tool recorded on the node is read first.
 */
export function decideTurn(turn: TurnResult): TurnDecision {
  if (turn.status === "unknown_outcome") return { next: "fail", reason: "unknown_outcome" };
  if (turn.shuttingDown && (turn.status === "cancelled" || turn.status === undefined)) return { next: "interrupted" };
  if (turn.status === "cancelled") return { next: "cancel" };
  if (turn.status === "awaiting_input") {
    if (!turn.endIntent) return { next: "fail", reason: "model_failed" };
    const { outcome, summary, assumptions, skipped } = turn.endIntent;
    return outcome === "done"
      ? { next: "succeed", summary, assumptions, skipped }
      : { next: "fail", reason: "blocked", summary, assumptions, skipped };
  }
  if (turn.status === "budget_exhausted") {
    if (turn.paused) return { next: "pause" };
    return !turn.madeProgress && turn.previousMadeProgress === false ? { next: "fail", reason: "stalled" } : { next: "segment" };
  }
  if (turn.quota) return { next: "pause" };
  if (turn.status === "completed") return { next: "succeed", summary: turn.text, assumptions: [], skipped: [] };
  if (turn.status === "empty_response" || turn.status === "stalled" || turn.status === "timed_out") return { next: "fail", reason: turn.status };
  return { next: "fail", reason: "model_failed" };
}

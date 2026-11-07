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
  failed: ["queued", "skipped", "waiting_children"],
  waiting_user: ["queued", "skipped", "cancelled"],
  waiting_team: ["queued", "cancelled"],
  waiting_children: ["queued", "cancelled"],
  // Only a root, and only when the owner asks: a follow-up, or a retry of one subtask.
  succeeded: ["queued", "waiting_children"],
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

/** What the owner can do about a failure in a responsive task, in the order it is offered. */
export const FAILURE_CHOICES = ["retry", "skip", "change", "end"] as const;
export type FailureChoice = typeof FAILURE_CHOICES[number];

export interface DecisionAnswer {
  /** Failures only. */
  choice?: FailureChoice;
  /** The reply to a question, or how to go about it differently. */
  text?: string;
}

export interface OwnerQuestion {
  question: string;
  options: string[];
  multiSelect: boolean;
}

/** The first thing the node reads when it wakes. The owner's own words stay as they are. */
export function resumeMessage(kind: "question" | "failure", answer: DecisionAnswer): string {
  if (kind === "question") return `[Owner reply]\n${answer.text ?? ""}`;
  if (answer.choice === "retry") return "[Owner decision] Try again. Check the execution records first and do not repeat anything that already took effect.";
  return `[Owner decision] Try a different approach. Check the execution records first.${answer.text ? `\nThe owner says:\n${answer.text}` : ""}`;
}

export function followUpMessage(text: string): string {
  return `[Owner follow-up] This task had ended, and the owner came back to it. Carry on from what you already did.\n${text}`;
}

export interface FinishIntent {
  outcome: "done" | "blocked";
  summary: string;
  assumptions: string[];
  skipped: string[];
}

/** Recorded by a tool, because every tool that ends a turn reports the same status. */
export type EndIntent = FinishIntent | { outcome: "wait" };

/** What a node is waiting for. Targets are node ids; `since` is the last board entry it had seen. */
export interface WaitFor {
  until: "progress" | "finished";
  targets: string[];
  since: number;
}

export interface TreeNode {
  id: string;
  status: AssignmentStatus;
  waitFor: WaitFor | null;
  /** Epoch milliseconds. */
  waitUntil: number | null;
}

export type WakeReason = "progress" | "finished" | "failed" | "deadlock" | "timeout" | "closing";

const WAKE_MESSAGES: Record<Exclude<WakeReason, "closing">, string> = {
  progress: "[Team update] A teammate you were waiting for published something new.",
  finished: "[Team update] The teammates you were waiting for have ended.",
  failed: "[Team update] A teammate you were waiting for failed.",
  deadlock: "[Team update] Every open subtask was waiting for another one, so all of you were woken. Do not wait for each other again: finish with what you have.",
  timeout: "[Team update] The time you set for waiting has passed.",
};

const CLOSING = "[All subtasks ended] Read the team board and the detail you need, then write the combined result for the owner and call finish_task. " +
  "Do not redo work a subtask finished.";
const CLOSING_RETRY = " If a failed subtask's result is really needed, use retry_subtask, then reply in one line and stop; you are woken again when it ends.";

/** Decides nothing about what comes next: the node reads the board and judges for itself. */
export function wakeMessage(reason: WakeReason, mode: AssignmentMode): string {
  if (reason === "closing") return mode === "autonomous" ? `${CLOSING}${CLOSING_RETRY}` : CLOSING;
  return `${WAKE_MESSAGES[reason]} Decide whether to wait again or go on with what you have.`;
}

/**
 * Who wakes, given one tree. `posts` is the newest finding or output per author. A target waiting for the
 * owner keeps its waiter waiting, so that alone is not a deadlock.
 */
export function planWakes(input: {
  rootId: string; nodes: TreeNode[]; posts: Map<string, number>; now: number;
}): Array<{ id: string; reason: WakeReason }> {
  const { rootId, nodes, posts, now } = input;
  const root = nodes.find((node) => node.id === rootId);
  const children = nodes.filter((node) => node.id !== rootId);
  const open = children.filter((node) => isOpenStatus(node.status));
  if (!open.length) return root?.status === "waiting_children" ? [{ id: rootId, reason: "closing" }] : [];

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const wakes: Array<{ id: string; reason: WakeReason }> = [];
  for (const node of open) {
    if (node.status !== "waiting_team" || !node.waitFor) continue;
    const { until, targets, since } = node.waitFor;
    const known = targets.map((id) => byId.get(id)).filter((target): target is TreeNode => Boolean(target));
    const reason: WakeReason | null =
      known.some((target) => target.status === "failed") ? "failed"
      : known.every((target) => !isOpenStatus(target.status)) ? "finished"
      : until === "progress" && targets.some((id) => (posts.get(id) ?? 0) > since) ? "progress"
      : node.waitUntil !== null && node.waitUntil <= now ? "timeout"
      : null;
    if (reason) wakes.push({ id: node.id, reason });
  }
  // Last, so a waiter whose targets simply ended is told that rather than blamed for a stalemate.
  if (!wakes.length && open.every((node) => node.status === "waiting_team")) return open.map((node) => ({ id: node.id, reason: "deadlock" }));
  return wakes;
}

export interface TurnResult {
  mode: AssignmentMode;
  /** Undefined when the run threw before the agent reported a status. */
  status: RunStatus | undefined;
  endIntent: EndIntent | null;
  /** Subtasks of this node still open. Only a root has any. */
  openChildren: number;
  /** What ask_user put to the owner this turn. */
  question: OwnerQuestion | null;
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
  | { next: "ask_failure"; reason: FailureReason; summary?: string; assumptions?: string[]; skipped?: string[] }
  | { next: "ask"; question: OwnerQuestion }
  | { next: "pause" }
  | { next: "segment" }
  | { next: "wait_team" }
  | { next: "wait_children" }
  | { next: "interrupted" }
  | { next: "cancel" };

/** Where a node goes after a turn with no subtasks yet. In a responsive task, a failure becomes the owner's decision. */
export function decideTurn(turn: TurnResult): TurnDecision {
  const decision = routeTurn(turn);
  return decision.next === "fail" && turn.mode === "responsive" ? { ...decision, next: "ask_failure" } : decision;
}

/** finish_task, wait_for_team and ask_user all report awaiting_input, so what the tool recorded on the node is read first. */
function routeTurn(turn: TurnResult): TurnDecision {
  if (turn.status === "unknown_outcome") return { next: "fail", reason: "unknown_outcome" };
  if (turn.shuttingDown && (turn.status === "cancelled" || turn.status === undefined)) return { next: "interrupted" };
  if (turn.status === "cancelled") return { next: "cancel" };
  if (turn.openChildren > 0) return { next: "wait_children" };
  if (turn.status === "awaiting_input") {
    if (turn.endIntent?.outcome === "wait") return { next: "wait_team" };
    if (!turn.endIntent) return turn.question && turn.mode === "responsive" ? { next: "ask", question: turn.question } : { next: "fail", reason: "model_failed" };
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

import { describe, expect, it } from "vitest";
import { decideTurn, InvalidTransitionError, planWakes, resumeMessage, transitionAssignment, type TreeNode, type TurnResult } from "./assignment-state.js";

const turn = (patch: Partial<TurnResult>): TurnResult => ({
  mode: "autonomous", status: "completed", endIntent: null, openChildren: 0, question: null, quota: false, paused: false, shuttingDown: false,
  text: "做完了", madeProgress: true, previousMadeProgress: null, ...patch,
});
const finish = { outcome: "done" as const, summary: "写好了", assumptions: ["按七折算"], skipped: [] };

describe("transitionAssignment", () => {
  it("follows the task lifecycle", () => {
    expect(transitionAssignment("queued", "running")).toBe("running");
    expect(transitionAssignment("running", "queued")).toBe("queued");
    expect(transitionAssignment("failed", "queued")).toBe("queued");
  });

  it("never leaves a final state", () => {
    expect(() => transitionAssignment("succeeded", "queued")).toThrow(InvalidTransitionError);
    expect(() => transitionAssignment("cancelled", "running")).toThrow(InvalidTransitionError);
    expect(() => transitionAssignment("failed", "cancelled")).toThrow(InvalidTransitionError);
  });
});

describe("decideTurn", () => {
  it("takes the result from finish_task", () => {
    expect(decideTurn(turn({ status: "awaiting_input", endIntent: finish }))).toEqual({ next: "succeed", summary: "写好了", assumptions: ["按七折算"], skipped: [] });
  });

  it("accepts a turn that ended without finish_task", () => {
    expect(decideTurn(turn({}))).toEqual({ next: "succeed", summary: "做完了", assumptions: [], skipped: [] });
  });

  it("fails on a blocked finish, keeping what the model wrote", () => {
    expect(decideTurn(turn({ status: "awaiting_input", endIntent: { ...finish, outcome: "blocked", summary: "查不到" } })))
      .toMatchObject({ next: "fail", reason: "blocked", summary: "查不到" });
  });

  it("treats a question in full autonomy as a failure", () => {
    expect(decideTurn(turn({ status: "awaiting_input" }))).toEqual({ next: "fail", reason: "model_failed" });
  });

  it("continues in a new segment, unless the task paused meanwhile", () => {
    expect(decideTurn(turn({ status: "budget_exhausted" }))).toEqual({ next: "segment" });
    expect(decideTurn(turn({ status: "budget_exhausted", paused: true }))).toEqual({ next: "pause" });
  });

  it("gives up after two segments without anything new", () => {
    expect(decideTurn(turn({ status: "budget_exhausted", madeProgress: false, previousMadeProgress: true }))).toEqual({ next: "segment" });
    expect(decideTurn(turn({ status: "budget_exhausted", madeProgress: false, previousMadeProgress: false }))).toEqual({ next: "fail", reason: "stalled" });
  });

  it("pauses instead of failing when the balance ran out", () => {
    expect(decideTurn(turn({ status: "failed", quota: true }))).toEqual({ next: "pause" });
  });

  it("does not treat a quota error as progress on a task with an unknown write", () => {
    expect(decideTurn(turn({ status: "unknown_outcome", quota: true }))).toEqual({ next: "fail", reason: "unknown_outcome" });
  });

  it.each(["empty_response", "stalled", "timed_out"] as const)("fails on %s", (status) => {
    expect(decideTurn(turn({ status }))).toEqual({ next: "fail", reason: status });
  });

  it("reads a generic failure and a thrown run the same way", () => {
    expect(decideTurn(turn({ status: "failed" }))).toEqual({ next: "fail", reason: "model_failed" });
    expect(decideTurn(turn({ status: undefined }))).toEqual({ next: "fail", reason: "model_failed" });
  });

  it("tells a shutdown from the owner cancelling", () => {
    expect(decideTurn(turn({ status: "cancelled" }))).toEqual({ next: "cancel" });
    expect(decideTurn(turn({ status: "cancelled", shuttingDown: true }))).toEqual({ next: "interrupted" });
    expect(decideTurn(turn({ status: undefined, shuttingDown: true }))).toEqual({ next: "interrupted" });
  });
});

describe("decideTurn in a responsive task", () => {
  const responsive = (patch: Partial<TurnResult>) => turn({ mode: "responsive", ...patch });
  const question = { question: "哪位王总？", options: ["华东的", "华南的"], multiSelect: false };

  it("stops for the owner when the employee asks", () => {
    expect(decideTurn(responsive({ status: "awaiting_input", question }))).toEqual({ next: "ask", question });
  });

  it("does not stop for a question full autonomy could not have asked", () => {
    expect(decideTurn(turn({ status: "awaiting_input", question }))).toEqual({ next: "fail", reason: "model_failed" });
  });

  it("turns every failure into the owner's decision, an unconfirmed write included", () => {
    for (const status of ["failed", "empty_response", "stalled", "timed_out", "unknown_outcome"] as const) {
      expect(decideTurn(responsive({ status })).next).toBe("ask_failure");
    }
    expect(decideTurn(responsive({ status: "awaiting_input", endIntent: { ...finish, outcome: "blocked" } })))
      .toEqual({ next: "ask_failure", reason: "blocked", summary: "写好了", assumptions: ["按七折算"], skipped: [] });
  });

  it("still finishes, pauses and segments the same way", () => {
    expect(decideTurn(responsive({ status: "awaiting_input", endIntent: finish })).next).toBe("succeed");
    expect(decideTurn(responsive({ status: "failed", quota: true })).next).toBe("pause");
    expect(decideTurn(responsive({ status: "budget_exhausted" })).next).toBe("segment");
    expect(decideTurn(responsive({ status: "cancelled" })).next).toBe("cancel");
  });
});

describe("resumeMessage", () => {
  it("keeps the owner's words and says who is speaking", () => {
    expect(resumeMessage("question", { text: "华东的" })).toBe("[Owner reply]\n华东的");
    expect(resumeMessage("failure", { choice: "retry" })).toContain("[Owner decision] Try again");
    expect(resumeMessage("failure", { choice: "change", text: "换组关键词" })).toContain("换组关键词");
  });
});

describe("decideTurn with subtasks", () => {
  it("sends a lead with open subtasks to wait, however its turn ended", () => {
    for (const patch of [{ status: "completed" }, { status: "failed" }, { status: "awaiting_input" }, { status: "budget_exhausted" }] as const) {
      expect(decideTurn(turn({ ...patch, openChildren: 2 }))).toEqual({ next: "wait_children" });
    }
  });

  it("lets a cancellation and an unconfirmed write through first", () => {
    expect(decideTurn(turn({ status: "cancelled", openChildren: 2 })).next).toBe("cancel");
    expect(decideTurn(turn({ status: "unknown_outcome", openChildren: 2 })).next).toBe("fail");
  });

  it("reads a wait from what the tool recorded", () => {
    expect(decideTurn(turn({ status: "awaiting_input", endIntent: { outcome: "wait" } }))).toEqual({ next: "wait_team" });
  });
});

describe("planWakes", () => {
  const ROOT = "root";
  const lead: TreeNode = { id: ROOT, status: "waiting_children", waitFor: null, waitUntil: null };
  const node = (id: string, status: TreeNode["status"], waitFor: TreeNode["waitFor"] = null, waitUntil: number | null = null): TreeNode =>
    ({ id, status, waitFor, waitUntil });
  const waiting = (id: string, targets: string[], until: "progress" | "finished" = "finished", since = 10) => node(id, "waiting_team", { until, targets, since });
  const plan = (nodes: TreeNode[], posts: Array<[string, number]> = [], now = 1_000) =>
    planWakes({ rootId: ROOT, nodes: [lead, ...nodes], posts: new Map(posts), now });

  it("closes the task once nothing is open, whichever way the subtasks ended", () => {
    expect(plan([node("a", "succeeded"), node("b", "failed"), node("c", "cancelled"), node("d", "skipped")])).toEqual([{ id: ROOT, reason: "closing" }]);
    expect(planWakes({ rootId: ROOT, nodes: [{ ...lead, status: "running" }, node("a", "succeeded")], posts: new Map(), now: 0 })).toEqual([]);
  });

  it("keeps the lead waiting while anything is open, a question to the owner included", () => {
    expect(plan([node("a", "succeeded"), node("b", "waiting_user")])).toEqual([]);
  });

  it("wakes on news only for a wait that asked for it, and only on news since it began", () => {
    const others = node("b", "running");
    expect(plan([waiting("a", ["b"], "progress"), others], [["b", 11]])).toEqual([{ id: "a", reason: "progress" }]);
    expect(plan([waiting("a", ["b"], "progress"), others], [["b", 10]])).toEqual([]);
    expect(plan([waiting("a", ["b"], "finished"), others], [["b", 11]])).toEqual([]);
  });

  it("wakes when targets end, and straight away on a failure", () => {
    const wait = waiting("a", ["b", "c"]);
    expect(plan([wait, node("b", "succeeded"), node("c", "running")])).toEqual([]);
    expect(plan([wait, node("b", "succeeded"), node("c", "succeeded")])).toEqual([{ id: "a", reason: "finished" }]);
    expect(plan([wait, node("b", "failed"), node("c", "running")])).toEqual([{ id: "a", reason: "failed" }]);
  });

  it("waits along with a target that is waiting for the owner", () => {
    expect(plan([waiting("a", ["b"]), node("b", "waiting_user")])).toEqual([]);
  });

  it("wakes everyone when all that is open is waiting", () => {
    const wakes = plan([waiting("a", ["b"]), waiting("b", ["a"]), node("c", "succeeded")]);
    expect(wakes).toEqual([{ id: "a", reason: "deadlock" }, { id: "b", reason: "deadlock" }]);
  });

  it("honours a deadline without letting one wake anyone early", () => {
    const wait = (at: number) => node("a", "waiting_team", { until: "finished", targets: ["b"], since: 0 }, at);
    expect(plan([wait(2_000), node("b", "running")])).toEqual([]);
    expect(plan([wait(500), node("b", "running")])).toEqual([{ id: "a", reason: "timeout" }]);
  });
});

describe("transitions for a reopened task", () => {
  it("lets a finished root wait again, and nothing else leave a final state", () => {
    expect(transitionAssignment("succeeded", "waiting_children")).toBe("waiting_children");
    expect(transitionAssignment("failed", "waiting_children")).toBe("waiting_children");
    expect(() => transitionAssignment("cancelled", "waiting_children")).toThrow(InvalidTransitionError);
  });
});

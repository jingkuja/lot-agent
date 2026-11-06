import { describe, expect, it } from "vitest";
import { decideTurn, InvalidTransitionError, transitionAssignment, type TurnResult } from "./assignment-state.js";

const turn = (patch: Partial<TurnResult>): TurnResult => ({
  status: "completed", endIntent: null, quota: false, paused: false, shuttingDown: false,
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

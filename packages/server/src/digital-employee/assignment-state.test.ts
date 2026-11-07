import { describe, expect, it } from "vitest";
import { decideTurn, InvalidTransitionError, resumeMessage, transitionAssignment, type TurnResult } from "./assignment-state.js";

const turn = (patch: Partial<TurnResult>): TurnResult => ({
  mode: "autonomous", status: "completed", endIntent: null, question: null, quota: false, paused: false, shuttingDown: false,
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

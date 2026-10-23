import { describe, expect, it } from "vitest";
import { textOperationEffect } from "./text-requests.js";

const editor = { version: 3, dirty: false, reviewShown: true };

describe("latest text request", () => {
  it("keeps editing locked while a request runs, is unknown or is being filled in", () => {
    for (const status of ["running", "unknown", "needs_apply"]) expect(textOperationEffect({ id: "a", status }, editor).pending).toBe(true);
    for (const status of ["succeeded", "failed", "cancelled", "released", "conflict"]) expect(textOperationEffect({ id: "a", status }, editor).pending).toBe(false);
    expect(textOperationEffect(undefined, editor)).toEqual({ pending: false, unknown: false, newRequestId: false, reload: false });
    expect(textOperationEffect({ id: "a", status: "unknown" }, editor).unknown).toBe(true);
  });
  it("asks for a new request ID only after a request ended without a result to replay", () => {
    for (const status of ["failed", "cancelled", "released"]) expect(textOperationEffect({ id: "a", status }, editor).newRequestId).toBe(true);
    for (const status of ["running", "unknown", "succeeded"]) expect(textOperationEffect({ id: "a", status }, editor).newRequestId).toBe(false);
  });
  it("reloads a result saved for a newer version, or a check of this version that is not shown yet", () => {
    expect(textOperationEffect({ id: "a", kind: "copy", status: "succeeded", appliedVersion: 4 }, editor).reload).toBe(true);
    expect(textOperationEffect({ id: "a", kind: "copy", status: "succeeded", appliedVersion: 3 }, editor).reload).toBe(false);
    expect(textOperationEffect({ id: "a", kind: "review", status: "succeeded", appliedVersion: 3 }, { ...editor, reviewShown: false }).reload).toBe(true);
    expect(textOperationEffect({ id: "a", kind: "review", status: "succeeded", appliedVersion: 3 }, editor).reload).toBe(false);
  });
  it("never replaces edits that are not saved yet", () => {
    expect(textOperationEffect({ id: "a", kind: "copy", status: "succeeded", appliedVersion: 9 }, { ...editor, dirty: true }).reload).toBe(false);
    expect(textOperationEffect({ id: "a", kind: "copy", status: "succeeded" }, editor).reload).toBe(false);
  });
});

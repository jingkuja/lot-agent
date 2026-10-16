import { describe, expect, it } from "vitest";
import { segmentRecoveryAction, UNKNOWN_SUBMISSION } from "./recovery.js";

describe("segment recovery classification", () => {
  it("classifies mixed results before considering charges or material rules", () => {
    expect([
      { output: { assetIds: ["existing"] } },
      { vendor_task_id: "original" },
      { vendor_task_id: "failed", output: { retrySafe: true } },
      {},
      { vendor_task_id: UNKNOWN_SUBMISSION, output: { retrySafe: true } },
    ].map(segmentRecoveryAction)).toEqual(["reuse", "poll", "submit", "submit", "unknown"]);
  });
});

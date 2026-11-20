import { describe, expect, it } from "vitest";
import { classifyComicTakeReconcile, COMIC_RECONCILE_SQL, needsComicTakeReconciliation } from "./operations-report.js";

describe("comic-drama reconciliation report classification", () => {
  it("includes gateway 5xx failures and distinguishes them from client 4xx rejections", () => {
    const gateway502 = { status: "failed", submit_state: "rejected", error: "VIDEO_GATEWAY_FAILED", gateway_http_status: 502 };
    expect(needsComicTakeReconciliation(gateway502)).toBe(true);
    expect(classifyComicTakeReconcile(gateway502)).toBe("gateway_5xx");

    const gateway504ByStatus = { status: "failed", submit_state: "rejected", error: "VIDEO_GENERATION_REJECTED", gateway_http_status: 504 };
    expect(needsComicTakeReconciliation(gateway504ByStatus)).toBe(true);
    expect(classifyComicTakeReconcile(gateway504ByStatus)).toBe("gateway_5xx");

    const client400 = { status: "failed", submit_state: "rejected", error: "VIDEO_GENERATION_REJECTED", gateway_http_status: 400 };
    expect(needsComicTakeReconciliation(client400)).toBe(false);
    expect(classifyComicTakeReconcile(client400)).toBe("client_4xx");

    const realPerson422 = { status: "failed", submit_state: "rejected", error: "REAL_PERSON_REJECTED", gateway_http_status: 422 };
    expect(needsComicTakeReconciliation(realPerson422)).toBe(false);
    expect(classifyComicTakeReconcile(realPerson422)).toBe("client_4xx");
  });

  it("classifies unknown, recoverable, and released takes for reconciliation", () => {
    expect(classifyComicTakeReconcile({ status: "unknown", submit_state: "unknown", error: "VIDEO_SUBMISSION_UNKNOWN", gateway_http_status: null }))
      .toBe("unknown_submission");
    expect(classifyComicTakeReconcile({ status: "recoverable", submit_state: "accepted", error: "VIDEO_RECOVERY_REQUIRED", gateway_http_status: null }))
      .toBe("recoverable");
    expect(classifyComicTakeReconcile({ status: "released", submit_state: "unknown", error: "SUBMISSION_RELEASED", gateway_http_status: null }))
      .toBe("released");
  });

  it("reconciliation SQL selects gateway_http_status, error_category, and VIDEO_GATEWAY_FAILED rows", () => {
    expect(COMIC_RECONCILE_SQL).toContain("t.gateway_http_status");
    expect(COMIC_RECONCILE_SQL).toContain("error_category");
    expect(COMIC_RECONCILE_SQL).toContain("VIDEO_GATEWAY_FAILED");
    expect(COMIC_RECONCILE_SQL).toContain("t.gateway_http_status>=500");
  });
});

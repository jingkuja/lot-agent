import { describe, expect, it } from "vitest";
import {
  classifyComicSpeechReconcile, classifyComicTakeReconcile, COMIC_RECONCILE_SQL, COMIC_SPEECH_RECONCILE_SQL,
  needsComicSpeechReconciliation, needsComicTakeReconciliation,
} from "./operations-report.js";

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

  it("P1 #5: includes speech attempts and legacy speech cache rows in reconciliation classification and SQL", () => {
    expect(needsComicSpeechReconciliation({ status: "unknown", error: "TRANSPORT_ERROR", gateway_http_status: null })).toBe(true);
    expect(classifyComicSpeechReconcile({ status: "unknown", error: "TRANSPORT_ERROR", gateway_http_status: null })).toBe("unknown_submission");
    expect(needsComicSpeechReconciliation({ status: "released", error: null, gateway_http_status: null })).toBe(true);
    expect(classifyComicSpeechReconcile({ status: "released", error: null, gateway_http_status: null })).toBe("released");
    expect(needsComicSpeechReconciliation({ status: "failed", error: "HTTP_ERROR", gateway_http_status: 503 })).toBe(true);
    expect(classifyComicSpeechReconcile({ status: "failed", error: "HTTP_ERROR", gateway_http_status: 503 })).toBe("gateway_5xx");
    expect(needsComicSpeechReconciliation({ status: "submitting", error: null, gateway_http_status: null, stale_submitting: true })).toBe(true);
    expect(needsComicSpeechReconciliation({ status: "failed", error: "HTTP_ERROR", gateway_http_status: 400 })).toBe(false);
    expect(COMIC_SPEECH_RECONCILE_SQL).toContain("lot_comic_drama.cd_speech_attempts");
    expect(COMIC_SPEECH_RECONCILE_SQL).toContain("lot_comic_drama.cd_speech_cache");
    expect(COMIC_SPEECH_RECONCILE_SQL).toContain("gateway_request_id");
  });
});

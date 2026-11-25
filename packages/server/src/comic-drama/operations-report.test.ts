import { describe, expect, it } from "vitest";
import {
  classifyComicSpeechReconcile, classifyComicTakeReconcile, COMIC_BILLING_VARIANCE_SQL, COMIC_RECONCILE_SQL,
  COMIC_RENDER_STATS_SQL, COMIC_SPEECH_RECONCILE_SQL, needsComicSpeechReconciliation, needsComicTakeReconciliation,
  summarizeComicPilotReport,
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

  it("P1 pilot report summarizes queue P95 by queue_name, render timings, temp free bytes, and billing variance", () => {
    expect(COMIC_RENDER_STATS_SQL).toContain("outputFps");
    expect(COMIC_BILLING_VARIANCE_SQL).toContain("settled_amount_micros");
    const summary = summarizeComicPilotReport({
      queues: [
        { queue_name: "lot-comic-video", type: "comic-drama.video", status: "succeeded", jobs: 10, wait_p95_ms: "1200", run_p95_ms: "42000" },
        { queue_name: "lot-comic-render", type: "comic-drama.render", status: "succeeded", jobs: 4, wait_p95_ms: "850", run_p95_ms: "28000" },
        { queue_name: "lot-marketing-video", type: "marketing.video", status: "succeeded", jobs: 6, wait_p95_ms: "400", run_p95_ms: "30000" },
      ],
      confirmed: { confirmed_requests: 12 },
      submissions: [
        { model: "doubao-seedance-2-5", status: "ready", takes: 8, submission_intents: 8, traced: 8, gateway_5xx: 1, client_4xx: 0, estimated_micros: "8000000" },
      ],
      speechSubmissions: [
        { kind: "dialogue", model: "qwen-audio-3.0-tts-plus", status: "ready", attempts: 5, traced: 5, gateway_5xx: 0 },
      ],
      renders: {
        total: 4, ready: 3, failed: 1, cancelled: 0,
        run_p50_ms: "14000", run_p95_ms: "28000", run_max_ms: "31000", fps_24_count: 3, fps_30_count: 1,
      },
      billingVariance: [{
        model: "doubao-seedance-2-5", currency: "CNY", settled_takes: 6, unbilled_ready_takes: 2, pending_reconcile_takes: 0,
        quoted_micros: "6000000", settled_micros: "6300000",
      }],
      recoveries: [],
      toReconcile: [{
        request_id: "r1", take_id: "t1", task_id: "j1", status: "unknown", submit_state: "unknown",
        error: "VIDEO_SUBMISSION_UNKNOWN", gateway_http_status: null, error_category: "unknown_submission", gateway_request_id: "gw-1",
      }],
      speechToReconcile: [],
    }, {
      uploads: { bytes: 2048, freeBytes: 5_000_000_000 },
      renders: { bytes: 4096, freeBytes: 8_000_000_000 },
    });

    expect(summary.queueWaitP95MsByQueue).toEqual({
      "lot-comic-video": 1200,
      "lot-comic-render": 850,
      "lot-marketing-video": 400,
    });
    expect(summary.unknownSubmissionCount).toBe(1);
    expect(summary.gateway5xxCount).toBe(1);
    expect(summary.renderRunP95Ms).toBe(28_000);
    expect(summary.renderFps24Count).toBe(3);
    expect(summary.renderFps30Count).toBe(1);
    expect(summary.tempTotalBytes).toBe(6144);
    expect(summary.tempFreeBytes).toBe(8_000_000_000);
    expect(summary.mediaFreeBytes).toBe(5_000_000_000);
    expect(summary.billingVariance).toEqual([{
      model: "doubao-seedance-2-5",
      currency: "CNY",
      settledTakes: 6,
      unbilledReadyTakes: 2,
      pendingReconcileTakes: 0,
      quotedMicros: 6_000_000,
      settledMicros: 6_300_000,
      variancePct: 5,
    }]);
  });
});

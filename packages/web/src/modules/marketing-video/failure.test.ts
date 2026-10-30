import { describe, expect, it } from "vitest";
import { MARKETING_FAILURE_CODES, type MarketingFailureCode } from "@lot-agent/core/marketing-video";
import { translate } from "../../i18n/locale.js";
import { videoFailure } from "./failure.js";

describe("marketing video failure guidance", () => {
  it("offers only an explicit, confirmed resubmission while a clip outcome is unknown", () => {
    for (const code of ["SUBMISSION_UNKNOWN", "GENERATION_FAILED", undefined] as const) {
      // The server's per-clip count decides, even when the parent error names another clip.
      expect(videoFailure(code, 2).actions).toEqual(["release", "support"]);
    }
    // After the user released the clips, the stale parent code must lead to a normal resume.
    expect(videoFailure("SUBMISSION_UNKNOWN", 0).actions).toContain("resume");
  });
  it("maps each cause code to an actionable next step", () => {
    const cases: [MarketingFailureCode, string, string[]][] = [
      ["REAL_PERSON_REJECTED", "所传素材有真人，未能通过服务商安全机制。", ["resume", "copy"]],
      ["MODEL_RATE_LIMIT", "视频模型当前繁忙或请求过于频繁。", ["resume"]],
      ["MODEL_AUTH_REQUIRED", "视频模型账号未授权，或尚未配置可用的模型密钥。", ["resume"]],
      ["GENERATION_FAILED", "视频模型未能完成部分片段。", ["resume", "copy"]],
      ["STATUS_UNCONFIRMED", "暂时无法查询片段的生成状态。", ["resume"]],
      ["CONNECT_FAILED", "暂时无法连接视频模型服务，片段没有提交。", ["resume"]],
      ["DOWNLOAD_INCOMPLETE", "片段已经生成，但下载到本地时没有完成。", ["resume"]],
      ["TIMED_OUT", "片段等待时间过长，暂未拿到生成结果。", ["resume"]],
      ["NOT_RECOVERABLE", "这次制作的配置或素材已无法继续使用。", ["copy"]],
      ["COMPOSITION_FAILED", "所有片段都已生成，合成成片时出现问题。", ["resume"]],
    ];
    for (const [code, reason, actions] of cases) expect(videoFailure(code), code).toMatchObject({ reason, actions });
    expect(videoFailure("REAL_PERSON_REJECTED").copyStep).toBe("production");
  });
  it("falls back to the generic guidance for tasks without a known code", () => {
    expect(videoFailure(undefined)).toMatchObject({ reason: "视频模型未能完成部分片段。", actions: ["resume", "copy"] });
    expect(videoFailure("FROM_A_NEWER_SERVER" as MarketingFailureCode)).toBe(videoFailure(undefined));
  });
  it("translates every cause and next step", () => {
    for (const code of [...MARKETING_FAILURE_CODES, undefined]) {
      for (const unknown of [0, 1]) {
        const failure = videoFailure(code, unknown);
        for (const text of [failure.reason, failure.next]) for (const locale of ["en", "id"] as const) expect(translate(text, locale), text).not.toBe(text);
      }
    }
  });
});

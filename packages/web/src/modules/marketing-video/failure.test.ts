import { describe, expect, it } from "vitest";
import { translate } from "../../i18n/locale.js";
import { videoFailure } from "./failure.js";

describe("marketing video failure guidance", () => {
  it("never offers a paid resubmission while a clip outcome is unknown", () => {
    for (const error of ["片段提交结果未知，请核实原任务；系统不会重复提交付费请求。", "片段提交结果未知，请核实原任务。"]) {
      expect(videoFailure(error, "片段完成 1/3").actions).toEqual(["support", "copy"]);
    }
  });
  it("maps provider errors to an actionable cause", () => {
    const cases: [string, string, string[]][] = [
      ["参考图包含真人，需先完成真人认证（create，REAL_PERSON_REJECTED，HTTP 400）", "视频模型判定参考图中包含真人，拒绝了生成。", ["resume", "copy"]],
      ["媒体供应商请求失败（create，HTTP_ERROR，HTTP 429）", "视频模型当前繁忙或请求过于频繁。", ["resume"]],
      ["媒体供应商请求失败（poll，HTTP_ERROR，HTTP 401）", "视频模型账号未授权，或尚未配置可用的模型密钥。", ["resume"]],
      ["数字员工生成任务缺少用户 TokenHub key", "视频模型账号未授权，或尚未配置可用的模型密钥。", ["resume"]],
      ["媒体供应商请求失败（poll，TASK_FAILED）", "视频模型未能完成部分片段。", ["resume", "copy"]],
      ["媒体供应商请求失败（poll，TRANSPORT_ERROR）", "暂时无法查询片段的生成状态。", ["resume"]],
      ["媒体供应商请求失败（download，TRANSPORT_ERROR）", "片段已经生成，但下载到本地时没有完成。", ["resume"]],
      ["generation timed out", "片段等待时间过长，暂未拿到生成结果。", ["resume"]],
      ["视频分段配置不完整", "这次制作的配置或素材已无法继续使用。", ["copy"]],
    ];
    for (const [error, reason, actions] of cases) expect(videoFailure(error, undefined), error).toMatchObject({ reason, actions });
    expect(videoFailure("参考图包含真人，需先完成真人认证（poll，REAL_PERSON_REJECTED）", undefined).copyStep).toBe(1);
  });
  it("reassembles stored clips after a composition failure", () => {
    expect(videoFailure("ffmpeg exited with code 1", "正在合成视频")).toMatchObject({ reason: "所有片段都已生成，合成成片时出现问题。", actions: ["resume"] });
  });
  it("translates every cause and next step", () => {
    for (const error of ["片段提交结果未知", "包含真人", "HTTP 401", "未配置", "HTTP 402", "HTTP 429", "正在收尾", "下载未完成", "TASK_FAILED", "timed out", "poll", "缺少配音", "任务不存在", "other"]) {
      const failure = videoFailure(error, undefined);
      for (const text of [failure.reason, failure.next]) expect(translate(text, "en"), text).not.toBe(text);
    }
    const composed = videoFailure("", "正在合成视频");
    expect(translate(composed.next, "id")).not.toBe(composed.next);
  });
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { GenerationCard } from "./GenerationCard.js";
import type { GenerationView } from "../hooks/useChat.js";

afterEach(() => vi.unstubAllGlobals());

function visibleText(patch: Partial<GenerationView> = {}) {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(GenerationCard, {
    generation: { mediaType: "video", status: "failed", taskId: "task-1", ...patch },
  })).replace(/<[^>]*>/g, "");
}

it("shows nested real-person rejection and billing reassurance directly on the card", () => {
  let error = JSON.stringify({ error: { code: "InputImageSensitiveContentDetected.PrivacyInformation", message: "The input image may contain real person." } });
  for (let i = 0; i < 3; i++) error = JSON.stringify({ code: "fail_to_fetch_task", message: error, data: null });
  const text = visibleText({ error });
  expect(text).toContain("上传的参考图包含真人，需要先完成真人认证后再使用。");
  expect(text).toContain("温馨提示：视频未成功生成，不会扣除积分。");
  expect(text).not.toContain("fail_to_fetch_task");
});

it("recognizes the extracted leaf message and provides a fallback for other failures", () => {
  expect(visibleText({ error: "The request failed because the input image 'content[0]' may contain real person." })).toContain("真人认证");
  expect(visibleText({ error: "参考图包含真人，需先完成真人认证（create，REAL_PERSON_REJECTED，HTTP 400）" })).toContain("需要先完成真人认证");
  const image = visibleText({ mediaType: "image", error: "参考图包含真人，需先完成真人认证（create，REAL_PERSON_REJECTED，HTTP 400）" });
  expect(image).toContain("需要先完成真人认证");
  expect(image).not.toContain("不会扣除积分");
  expect(visibleText({ mediaType: "image", error: "upstream error" })).not.toContain("请稍后再试");
  expect(visibleText({ error: "upstream error" })).toContain("请稍后再试，或联系客服。");
  expect(visibleText()).toContain("请稍后再试，或联系客服。");
});

it("does not claim no charge when the result is unknown, downloading, cancelled or successful", () => {
  for (const patch of [
    { error: "生成状态获取失败" },
    { taskId: undefined, error: "生成请求失败：Failed to fetch" },
    { status: "download_failed" as const },
    { status: "cancelled" as const },
    { status: "generating" as const },
    { status: "completed" as const },
    { status: "completed" as const, assets: [{ url: "/video.mp4", mime: "video/mp4" }] },
  ]) expect(visibleText(patch)).not.toContain("不会扣除积分");
  expect(visibleText({ error: "生成状态获取失败" })).toContain("暂时无法确认视频生成结果，请刷新会话查看，或联系客服。");
});

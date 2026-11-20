import { describe, expect, it } from "vitest";
import { ApiClientError } from "../../api/client.js";
import { messages } from "../../i18n/messages.js";
import { comicDirectorError } from "./director-api.js";
import { comicRenderError, editError } from "./edit-api.js";
import { comicGenerationError } from "./GenerationQuoteDialog.js";

describe("comic-drama error copy and trilingual i18n coverage", () => {
  it("maps compliance, speech release and expanded render limits with trilingual translations", () => {
    const compliance = new ApiClientError("blocked", 400, "CONTENT_COMPLIANCE_REJECTED");
    expect(comicGenerationError(compliance)).toBe("内容未通过安全合规检查，请修改剧本、分镜或台词后重试");
    expect(editError(compliance)).toBe("内容未通过安全合规检查，请修改剧本、分镜或台词后重试");
    expect(comicDirectorError(compliance)).toBe("内容未通过安全合规检查，请修改剧本、分镜或台词后重试");

    const speechUnreleasable = new ApiClientError("busy", 409, "EDIT_SPEECH_NOT_RELEASABLE");
    expect(editError(speechUnreleasable)).toBe("此句配音暂不可释放，请重新读取台词");
    expect(comicRenderError("RENDER_LIMIT")).toBe("导出最多支持 5 分钟、60 段视频及 240 条音频");

    const requiredKeys = [
      "费用待核实",
      "费用待核实，暂不可提交",
      "内容未通过安全合规检查，请修改剧本、分镜或台词后重试",
      "导出正片包含 AI 生成内容，发布至外部平台时请按平台规范标注“内容由 AI 生成”。",
      "导出最多支持 5 分钟、60 段视频及 240 条音频",
      "此句配音暂不可释放，请重新读取台词",
      "原配音请求可能已扣费。释放后可重新合成，新请求可能再次扣费。确认释放？",
      "查看原件",
      "下载原件",
      "查看原图",
      "一键配音与字幕",
      "画风预设与参考图",
      "默认模型设置",
      "音色试听",
      "整集查漏",
      "成片详情",
      "片源架",
      "另存为素材",
      "按剧集分组",
      "纯时间线",
      "继续上次剪辑",
      "删除此剧集？已导出的正片不会删除。",
      "当前剧集仍有 {0} 个成片在生成，会在后台继续",
      "该素材正在剪辑工程或画风参考中使用，无法删除",
      "该造型套装正在剧集选角中使用，无法删除",
    ];
    for (const key of requiredKeys) {
      expect(messages[key]?.en).toBeTruthy();
      expect(messages[key]?.id).toBeTruthy();
    }
  });
});

import { describe, expect, it } from "vitest";
import type { ComicSpeechPresetMeta } from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { messages } from "../../i18n/messages.js";
import { presetVoiceLabel } from "./ComicCharacterVoice.js";
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
    expect(editError(new ApiClientError("superseded", 409, "EDIT_SPEECH_SUPERSEDED")))
      .toBe("旧的配音请求已失效，请以最新提交结果为准");
    expect(comicGenerationError(new ApiClientError("sel", 409, "SELECTION_CONFLICT")))
      .toBe("该分镜的采用版本已被其他窗口更新，请刷新后重试");
    expect(comicGenerationError(new ApiClientError("mat", 400, "INVALID_MATERIAL_REFERENCE")))
      .toBe("所选场景、道具或音效素材不可用，请重新选择");
    expect(comicDirectorError(new ApiClientError("rev", 409, "REVISION_CONFLICT")))
      .toBe("剧集已被其他窗口更新，请刷新后重试");
    expect(comicDirectorError(new ApiClientError("empty", 400, "DIRECTOR_EMPTY_SCRIPT")))
      .toBe("当前剧集暂无剧本内容，请先编写或生成剧本");
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
      "已花费 暂无实扣",
      "未出账估算 {0}",
      "待核对 {0} 笔",
      "该分镜的采用版本已被其他窗口更新，请刷新后重试",
      "分镜绑定的场景或道具素材已失效，请重新选择",
      "所选场景、道具或音效素材不可用，请重新选择",
      "旧的配音请求已失效，请以最新提交结果为准",
      "批量配音范围核对",
      "确认并执行批量配音",
      "裁切并入轨（复用缓存）",
      "按调整项重试",
      "镜头音效",
      "镜头开始",
      "镜头中段",
      "镜头结尾",
      "待处理 {0} 个（单批上限 10，本批 {1} + 余 {2}）",
      "全部首帧已审核完成；如需重新生成，请手动勾选分镜后再预览费用。",
      "片段原声已静音",
      "试听轨道",
      "整集费用预估",
      "积分消耗快尽，为避免任务执行中途中断，请充值后继续使用。",
      "暂时无法核实视频所需积分或余额，未提交生成。",
      "模型网关余额不足，补足额度后可重新检查积分。",
      "当前可用 {0} 积分，预计需要 {1} 积分",
      "重新检查积分",
      "继续生成",
      "视频默认模型用于新建剧集，图片档位用于角色造型、分镜首帧和图片素材。导演文字模型由系统自动选择。",
      "AI 增强",
      "AI 增强整篇剧本",
      "AI 增强选中原文",
      "AI 增强段落",
      "增强范围",
      "整篇剧本",
      "一段原文",
      "分镜卡",
      "当前剧集暂无剧本内容，请先编写或生成剧本",
      "分镜增强建议",
      "剧本增强建议",
      "原稿已更新，请重新核对",
      "基于最新草稿重新生成",
      "采用本段",
      "舍弃本段",
      "恢复建议",
      "全部采用",
      "部分已采用",
      "原稿",
      "建议",
      "整部剧集",
      "分集",
      "剧集层级路径",
      "当前分镜所属剧集与分集",
      "切换分集",
      "新增分集",
      "编辑整部剧集",
      "新建整部剧集",
      "整部剧集名称",
      "整部剧集简介",
      "所属整部剧集",
      "所属分集",
      "本剧分集",
      "剧集总览",
      "第 {0} 集",
      "共 {0} 集",
      "共 {0} 个分镜",
      "分镜 {0}/{1}",
      "当前分镜",
      "当前制作范围",
      "删除整部剧集？其下所有分集也将被删除，已导出的正片不会删除。",
      "归档整部剧集？其下所有分集也将一并归档。",
    ];
    for (const key of requiredKeys) {
      expect(messages[key]?.en).toBeTruthy();
      expect(messages[key]?.id).toBeTruthy();
    }
  });

  it("prefers server-returned presetCatalog labels and falls back to COMIC_SPEECH_PRESET_CATALOG", () => {
    const qwenPresets: readonly ComicSpeechPresetMeta[] = [
      {
        id: "nova",
        gender: "female",
        age: "young_adult",
        tone: "balanced",
        labels: {
          zh: "龙安灵心 · 温暖女声",
          en: "Lingxin · Warm Female Voice",
          id: "Lingxin · Suara Wanita Hangat",
        },
        summary: {
          zh: "温暖自然",
          en: "Warm and natural",
          id: "Hangat dan alami",
        },
      },
    ];
    expect(presetVoiceLabel("nova", "zh", qwenPresets)).toBe("龙安灵心 · 温暖女声");
    expect(presetVoiceLabel("nova", "en", qwenPresets)).toBe("Lingxin · Warm Female Voice");
    expect(presetVoiceLabel("nova", "id", qwenPresets)).toBe("Lingxin · Suara Wanita Hangat");
    expect(presetVoiceLabel("alloy", "zh", qwenPresets)).toBe("清朗中性 · 青年");
    expect(presetVoiceLabel("nova", "zh")).toBe("明快女声 · 少女/青年");
    expect(presetVoiceLabel("unknown_voice", "zh", qwenPresets)).toBe("unknown_voice");
  });
});

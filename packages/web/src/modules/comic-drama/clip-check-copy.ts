import type { ComicClipCheckIssue } from "@lot-agent/core/comic-drama";

const refLabels = {
  scene: "场景",
  prop: "道具",
  sfx: "音效",
  image: "参考图",
  audio: "参考音频",
  video: "参考视频",
  last_frame: "尾帧",
} as const;

type TranslateFn = (key: string, params?: (string | number)[]) => string;

export function describeComicClipCheckIssue(issue: ComicClipCheckIssue, t: TranslateFn): string {
  switch (issue.code) {
    case "SPEAKER_NOT_IN_CAST":
      return t("台词说话人「{0}」未在本镜出镜人物中", [issue.speaker]);
    case "REFERENCE_LIMIT_EXCEEDED":
      return t("当前参考图共 {0} 张，超出模型上限（{1} 张）", [issue.count, issue.limit]);
    case "DIALOGUE_TOO_LONG":
      return t("台词估算约 {0} 秒，超出本镜时长（{1} 秒）", [+(issue.estimatedMs / 1000).toFixed(1), +(issue.durationMs / 1000).toFixed(1)]);
    case "CAST_UPDATED_IN_LIBRARY":
      return issue.reason === "generated_outdated"
        ? t("角色「{0}」当前造型已晚于已生成版本，建议核对或重生成", [issue.characterName])
        : t("角色「{0}」在角色库中有更新，可到选角处同步", [issue.characterName]);
    case "INVALID_MATERIAL_REFERENCE":
      return t("所绑定的{0}素材「{1}」已失效（{2}），请重新绑定或移除", [
        t(refLabels[issue.role]),
        issue.name ?? issue.materialId.slice(0, 8),
        t(issue.reason === "ARCHIVED" ? "已归档" : issue.reason === "OUTDATED_VERSION" ? "已有新版"
          : issue.reason === "WRONG_KIND" ? "类别不符" : "已缺失"),
      ]);
    case "DURATION_OUT_OF_RANGE":
      return t("分镜时长 {0} 秒超出当前模型范围（{1}–{2} 整秒）", [
        +(issue.durationMs / 1000).toFixed(2),
        issue.minSeconds,
        issue.maxSeconds,
      ]);
    case "RESOLUTION_UNSUPPORTED":
      return issue.suggestedResolution
        ? t("输出分辨率 {0} 不被当前模型支持（建议映射为 {1}）", [issue.resolution, issue.suggestedResolution])
        : t("输出分辨率 {0} 不被当前模型支持（允许 {1}）", [issue.resolution, issue.allowed.join(" / ")]);
    case "MEDIA_REFERENCE_LIMIT_EXCEEDED": {
      const label = issue.field === "audio" ? "参考音频" : issue.field === "videos" ? "参考视频" : "参考文件总数";
      return t("{0}共 {1} 个，超出模型上限（{2} 个）", [t(label), issue.count, issue.limit]);
    }
    case "VIDEO_MODE_UNSUPPORTED":
      return t("当前视频模型不支持「{0}」模式", [t(issue.operation === "extend" ? "视频延长" : "视频编辑")]);
    case "AUDIO_ONLY_UNSUPPORTED":
      return t("当前模型不支持仅传参考音频，请至少补充 1 张参考图或 1 段参考视频");
    case "AUDIO_REFERENCE_REQUIRED":
      return t("当前已选外部参考音频驱动口型，请先绑定参考音频");
    case "AUDIO_MODE_CONFLICT":
      return t("已绑定 {0} 段参考音频，但音频模式设为「{1}」，建议切换为外部参考音频或移除音频引用", [
        issue.audioCount,
        t(issue.audioMode === "native_audio" ? "原生音画" : "后期配音"),
      ]);
  }
}

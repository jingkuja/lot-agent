/** What a stopped video task means for the user, and which action can move it forward. */
export type VideoFailure = {
  reason: string;
  next: string;
  /** resume: continue the same task; copy: the frozen task cannot succeed as is; support: outcome must be verified first;
   * release: the user may accept a possible duplicate charge and resubmit only the unknown clips. */
  actions: ("resume" | "copy" | "support" | "release")[];
  /** Creation step a copied draft opens at: materials (1) or shots (2). */
  copyStep?: 1 | 2;
};

const segmentFailed: VideoFailure = {
  reason: "视频模型未能完成部分片段。",
  next: "点击继续生成只会重做未完成的片段（可能产生费用），已完成的片段会保留。如反复失败，可复制为新草稿调整分镜或素材。",
  actions: ["resume", "copy"],
};
// Decided from the server's per-clip state, not from error text: the parent error
// names only the first failure, and released clips must stop showing this.
const unknownSubmission: VideoFailure = {
  reason: "有片段已发送给视频模型，但没有收到明确结果。为避免重复扣费，系统不会自动重新提交。",
  next: "可以确认后只重新提交这些片段（可能重复计费），已完成的片段会保留；如需核实费用，请联系客服并提供任务编号。",
  actions: ["release", "support"],
};
const rules: [RegExp, VideoFailure][] = [
  [/CONNECT_ERROR/, {
    reason: "暂时无法连接视频模型服务，片段没有提交。",
    next: "请稍后点击继续生成，不会重复计费。已完成的片段不会重做。",
    actions: ["resume"],
  }],
  [/REAL_PERSON_REJECTED|包含真人|PrivacyInformation|real person/i, {
    reason: "视频模型判定参考图中包含真人，拒绝了生成。",
    next: "完成真人认证后可点击继续生成；或复制为新草稿，替换人物图片后重新制作。",
    actions: ["resume", "copy"], copyStep: 1,
  }],
  [/TokenHub key|HTTP 401|HTTP 403|未授权|密钥/, {
    reason: "视频模型账号未授权，或尚未配置可用的模型密钥。",
    next: "请检查账号中的模型密钥配置，完成后点击继续生成。已完成的片段不会重做。",
    actions: ["resume"],
  }],
  [/未配置|不可用，请配置/, {
    reason: "服务端缺少生成所需的配置。",
    next: "请联系管理员处理，完成后点击继续生成。已完成的片段不会重做。",
    actions: ["resume", "support"],
  }],
  [/HTTP 402|余额|quota/i, {
    reason: "模型账户余额不足。",
    next: "充值后点击继续生成。已完成的片段不会重做。",
    actions: ["resume"],
  }],
  [/HTTP 429|rate limit|繁忙/i, {
    reason: "视频模型当前繁忙或请求过于频繁。",
    next: "请等待几分钟后点击继续生成。已完成的片段不会重做。",
    actions: ["resume"],
  }],
  [/正在处理|正在收尾/, {
    reason: "上一次制作仍在收尾。",
    next: "请稍等片刻，再点击继续生成。",
    actions: ["resume"],
  }],
  [/下载未完成|download/i, {
    reason: "片段已经生成，但下载到本地时没有完成。",
    next: "点击继续生成会重新下载原片段，不会再次调用视频模型。",
    actions: ["resume"],
  }],
  [/TASK_FAILED|generation failed/i, segmentFailed],
  [/timed out|超时/i, {
    reason: "片段等待时间过长，暂未拿到生成结果。",
    next: "点击继续生成会继续查询原片段，不会重复提交。",
    actions: ["resume"],
  }],
  [/状态暂时无法确认|TRANSPORT_ERROR|INVALID_RESPONSE|poll/i, {
    reason: "暂时无法查询片段的生成状态。",
    next: "点击继续生成会查询原片段的结果，不会重复提交。",
    actions: ["resume"],
  }],
  [/缺少配音|时长不足/, {
    reason: "有片段缺少配音或时长不足，未通过质量检查。",
    next: "点击继续生成只会重新生成该片段（会产生该片段费用）。",
    actions: ["resume", "copy"],
  }],
  [/分段配置不完整|不可恢复|素材不可用|背景音乐不可用|任务不存在|提示词过长|参考视频|最多 3 张/, {
    reason: "这次制作的配置或素材已无法继续使用。",
    next: "请复制为新草稿，检查分镜和素材后重新制作。",
    actions: ["copy"],
  }],
];

export function videoFailure(error: string | undefined, stage: string | undefined, unknownSegments = 0): VideoFailure {
  if (unknownSegments > 0) return unknownSubmission;
  // Every clip is stored before composition starts, so its errors never need a model call.
  if (stage === "正在合成视频") return {
    reason: "所有片段都已生成，合成成片时出现问题。",
    next: "点击继续生成会用已生成的片段重新合成，不会再次调用视频模型。",
    actions: ["resume"],
  };
  return rules.find(([pattern]) => pattern.test(error ?? ""))?.[1] ?? segmentFailed;
}

import { describe, expect, it } from "vitest";
import { MARKETING_REVIEW_RULE_VERSION, MarketingDraftSchema, storyboardScript } from "@lot-agent/core/marketing-video";
import { localMarketingReview, normalizeMarketingReview, REVIEW_INSTRUCTION } from "./compliance.js";
import { MARKETING_RISK_TABLE } from "./compliance-rules.js";

const cleanModel = { verdict: "pass", issues: [] };
describe("marketing content compliance", () => {
  it("imports the workbook percentage and all conditional and exception rows", () => {
    expect(MARKETING_RISK_TABLE.blacklist).toHaveLength(14);
    expect(MARKETING_RISK_TABLE.conditionalRules).toHaveLength(37);
    expect(MARKETING_RISK_TABLE.exceptions).toHaveLength(14);
    expect(MARKETING_RISK_TABLE.conditionalRules.find(rule => rule.id === "risk-table-4")?.terms).toEqual(["100%"]);
  });
  it("checks narration, every storyboard field, title, tags and background even if the model passes", () => {
    const shot = { script: "投资项目必赚。", visual: "展示100%治愈的产品海报。", action: "演员举起产品宣传根治。", camera: "特写保健品抗癌字样。" };
    const draft = MarketingDraftSchema.parse({ script: "欢迎了解产品。", storyboard: [shot], background: "背景招牌写着零风险投资项目", publishTitle: "专利配方食品", tags: "#原单奢侈品" });
    const review = normalizeMarketingReview(draft, cleanModel)!;
    expect(review.verdict).toBe("suspect");
    expect(review.ruleVersion).toBe(MARKETING_REVIEW_RULE_VERSION);
    expect(new Set(review.issues.map(issue => issue.field))).toEqual(new Set(["storyboard.script", "storyboard.visual", "storyboard.action", "storyboard.camera", "background", "publishTitle", "tags"]));
  });
  it("scopes harmless senses locally and never lets one whitelist bypass the document", () => {
    const draft = MarketingDraftSchema.parse({ script: "视频剪辑特效非常有趣。食品100%治愈疾病。投资项目稳赚。", storyboard: [{ script: "带你加入赌博平台下注。", visual: "视频特效画面", action: "展示咖啡", camera: "固定" }] });
    const review = normalizeMarketingReview(draft, cleanModel)!;
    expect(review.verdict).toBe("reject");
    expect(review.issues.some(issue => issue.ruleId === "risk-table-6")).toBe(false);
    expect(review.issues.map(issue => issue.ruleId)).toEqual(expect.arrayContaining(["risk-table-4", "risk-table-3", "risk-table-blacklist"]));
    const mixed = localMarketingReview(MarketingDraftSchema.parse({ script: "100%纯棉材质，产品100%见效。" }));
    expect(mixed.some(issue => issue.ruleId === "risk-table-4")).toBe(true);
  });
  it("does not treat certificates, patents, or agreements as verified evidence", () => {
    for (const script of ["专利配方，附带真实专利号CN123。", "祛斑化妆品，国妆特证编号123。", "消炎医用产品，医疗器械备案号123。", "医生推荐，正规合作协议已公示。", "第一，第三方榜单数据。", "纯天然，原材料检测报告。", "生发，国妆特证。"])
      expect(normalizeMarketingReview(MarketingDraftSchema.parse({ script }), cleanModel)?.verdict).toBe("suspect");
  });
  it("keeps educational warnings and unrelated physical/video terms contextual", () => {
    for (const script of ["警惕赌博骗局，远离毒品。", "这是影视特效制作，不提供治病建议。", "100%纯棉材质。", "直播间商品秒杀活动。", "服务器跑分最强。"])
      expect(localMarketingReview(MarketingDraftSchema.parse({ script }))).toEqual([]);
    expect(localMarketingReview(MarketingDraftSchema.parse({ script: "请拒绝骗局。加入赌博平台。" })).some(issue => issue.severity === "reject")).toBe(true);
    for (const script of ["不是骗局，这个投资项目必赚。", "并非普通产品，本产品100%治愈。", "不承诺旧项目，本项目稳赚。", "视频特效很酷，这个特效产品可以解决所有炎症。", "服务器跑分最强，这款产品也最强。"])
      expect(normalizeMarketingReview(MarketingDraftSchema.parse({ script }), cleanModel)?.verdict).toBe("suspect");
    expect(localMarketingReview(MarketingDraftSchema.parse({ script: "不承诺投资项目必赚。" }))).toEqual([]);
  });
  it("rejects invented locations, excerpts, rule sources and contradictory verdicts", () => {
    const draft = MarketingDraftSchema.parse({ script: "欢迎了解产品。" });
    const issue = { text: "产品", reason: "核实来源", suggestion: "商品", field: "script", source: "xiaohongshu", ruleId: "platform-copyright", severity: "suspect" };
    for (const invalid of [
      { verdict: "pass", issues: [issue] }, { verdict: "reject", issues: [] },
      { verdict: "suspect", issues: [{ ...issue, text: "从未出现" }] },
      { verdict: "suspect", issues: [{ ...issue, field: "storyboard.visual", shotIndex: 0 }] },
      { verdict: "suspect", issues: [{ ...issue, field: "script", shotIndex: 0 }] },
      { verdict: "suspect", issues: [{ ...issue, ruleId: "invented-law" }] },
      { verdict: "suspect", issues: [{ ...issue, source: "douyin", ruleId: "platform-diversion" }] },
      { verdict: "suspect", issues: [{ text: "产品", reason: "核实", suggestion: "商品" }] },
      { verdict: "reject", issues: [issue] },
    ]) expect(normalizeMarketingReview(draft, invalid)).toBeNull();
    expect(normalizeMarketingReview(draft, { verdict: "suspect", issues: [issue] })?.verdict).toBe("suspect");
  });
  it("preserves the strongest finding and deduplicates mirrored narration", () => {
    const storyboard = [{ script: "项目稳赚。", visual: "普通场景", action: "展示", camera: "中景" }];
    const draft = MarketingDraftSchema.parse({ script: storyboardScript(storyboard), storyboard });
    const local = localMarketingReview(draft).find(issue => issue.field === "storyboard.script")!;
    const review = normalizeMarketingReview(draft, { verdict: "reject", issues: [{ ...local, severity: "reject" }] })!;
    expect(review.verdict).toBe("reject");
    expect(review.issues.find(issue => issue.field === "storyboard.script")?.severity).toBe("reject");
  });
  it("gives the model contextual rather than document-wide exemptions", () => {
    expect(REVIEW_INSTRUCTION).toContain("same local context, never the entire");
    expect(REVIEW_INSTRUCTION).toContain("NOT verified evidence");
    expect(REVIEW_INSTRUCTION).toContain("platform-minors");
    expect(REVIEW_INSTRUCTION).toContain("platform-copyright");
  });
});

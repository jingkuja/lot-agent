import type { TodayItem } from "../types.js";

type Translate = (text: string, values?: readonly unknown[]) => string;

/** Card copy is written here from stored fields, so it follows the interface language. */
export function proposalCopy(item: TodayItem, t: Translate): { title: string; detail: string | null } {
  const proposal = item.proposal!;
  const preview = proposal.preview;
  const value = (key: string) => (typeof preview[key] === "string" ? preview[key] as string : "");
  const customer = value("customerName");
  switch (proposal.kind) {
    case "follow_up_action": {
      const operation = value("operation");
      const titles: Record<string, string> = {
        create: "给{0}安排跟进：{1}", accept: "采纳{0}的商机：{1}", snooze: "把{0}的商机放到稍后：{1}", dismiss: "忽略{0}的商机：{1}",
        reschedule: "改{0}的跟进时间：{1}", cancel: "取消{0}的跟进：{1}", execute: "把{0}的跟进标记为已执行：{1}",
      };
      return { title: t(titles[operation] ?? "处理{0}的跟进：{1}", [customer, value("title")]), detail: value("objective") || null };
    }
    case "follow_up_result":
      return { title: t("回填{0}的跟进结果：{1}", [customer, value("title")]), detail: value("nextAction") || null };
    case "customer_segment": {
      const metrics = preview.metrics as { totalProfiles?: number } | undefined;
      return { title: t("保存客群：{0}", [value("name")]), detail: t("约 {0} 人", [metrics?.totalProfiles ?? 0]) };
    }
    case "marketing_campaign":
      return { title: t("创建活动：{0}", [value("name")]), detail: t("面向{0}，推广{1}", [value("audience") || t("已确认客群"), value("productName")]) };
    case "asset_deployment":
      return { title: t("标记投放：{0}", [value("title")]), detail: value("platform") || null };
    case "deployment_feedback":
      return { title: t("回填投放反馈：{0}", [value("title")]), detail: null };
    case "campaign_result":
      return { title: t("写入活动结果：{0}", [value("name")]), detail: t("生成完成不算投放结果，这里记录的是真实反馈。") };
    case "product_import": {
      const products = (preview.products ?? []) as Array<{ items: number }>;
      const items = products.reduce((sum, product) => sum + product.items, 0);
      return { title: t("整理好了：{0}", [value("title")]), detail: t("{0} 个产品，{1} 条内容", [products.length, items]) };
    }
    case "customer_capture":
      return { title: t("记录{0}的动态", [value("customerMention")]), detail: value("excerpt") || null };
    case "profile_change":
      return { title: t("修改{0}的客户档案", [value("customerMention")]), detail: t("需要先选择或确认关键字段") };
    default:
      return { title: item.title, detail: null };
  }
}

export function runningLabel(type: string): string {
  if (type === "image.generate") return "生成海报";
  if (type === "video.generate") return "生成视频";
  if (type === "opportunity.discover") return "看一遍客户";
  if (type === "employee.schedule.run") return "准备定时工作";
  return "处理任务";
}

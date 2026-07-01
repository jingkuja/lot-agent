/** 新用户默认安装的子 Agent。通用是基础能力,对每个登录用户始终可用,
 *  由路由强制标记为已安装,不入库绑定,因此不在此列表中。 */
export const DEFAULT_INSTALLED_AGENT_IDS = ["image", "video"] as const;

/** 永远已安装、不可卸载、恒排第一的通用 Agent id(不入库、不进 Agent 中心)。 */
export const GENERAL_AGENT_ID = "general";

/** 追加安装时的 sort_order:排到当前最大之后。 */
export function nextSortOrder(existing: number[]): number {
  return (existing.length ? Math.max(...existing) : -1) + 1;
}

/** MRU 插队:排到当前所有子 Agent 之前(min - 1)。 */
export function promotedSortOrder(subAgentOrders: number[]): number {
  return (subAgentOrders.length ? Math.min(...subAgentOrders) : 0) - 1;
}

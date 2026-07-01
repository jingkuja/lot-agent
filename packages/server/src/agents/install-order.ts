/** 新用户默认安装的 Agent(general 必须第一)。 */
export const DEFAULT_INSTALLED_AGENT_IDS = ["general", "image", "video"] as const;

/** 永远已安装、不可卸载、恒排第一的通用 Agent id。 */
export const GENERAL_AGENT_ID = "general";

/** 追加安装时的 sort_order:排到当前最大之后。 */
export function nextSortOrder(existing: number[]): number {
  return (existing.length ? Math.max(...existing) : -1) + 1;
}

/** MRU 插队:排到当前所有子 Agent 之前(min - 1)。 */
export function promotedSortOrder(subAgentOrders: number[]): number {
  return (subAgentOrders.length ? Math.min(...subAgentOrders) : 0) - 1;
}

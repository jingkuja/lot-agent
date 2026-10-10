export const GENERAL_ID = "general";

export const MAX_VISIBLE_SUBAGENTS = 6;

/** 营销影像固定为首个子 Agent（通用助手之后）；其余按历史 sortOrder 排序。 */
export function sortedSubAgents<T extends { id: string; sortOrder?: number | null }>(
  installed: T[]
): T[] {
  const rank = (a: T) => (a.sortOrder == null ? Number.POSITIVE_INFINITY : a.sortOrder);
  return installed
    .filter((a) => a.id !== GENERAL_ID)
    .sort((a, b) => {
      if (a.id === "marketing_video") return b.id === "marketing_video" ? 0 : -1;
      if (b.id === "marketing_video") return 1;
      return rank(a) - rank(b);
    });
}

export interface SplitAgents<T> {
  general: T | null;
  visible: T[];
  overflow: T[];
}

/** 传入已安装 agents:抽出 general,营销影像优先，其余按 sortOrder 升序(null 最后),
 *  前 MAX_VISIBLE_SUBAGENTS 个可见,其余进溢出。 */
export function splitInstalledAgents<T extends { id: string; sortOrder?: number | null }>(
  installed: T[]
): SplitAgents<T> {
  const general = installed.find((a) => a.id === GENERAL_ID) ?? null;
  const subs = sortedSubAgents(installed);
  return {
    general,
    visible: subs.slice(0, MAX_VISIBLE_SUBAGENTS),
    overflow: subs.slice(MAX_VISIBLE_SUBAGENTS),
  };
}

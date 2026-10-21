export const GENERAL_ID = "general";

export const MAX_VISIBLE_SUBAGENTS = 6;

/** 营销影像、数字主播依次固定在通用助手之后；其余按历史 sortOrder 排序。 */
const PINNED = ["marketing_video", "digital_presenter"];
export function sortedSubAgents<T extends { id: string; sortOrder?: number | null }>(
  installed: T[]
): T[] {
  const rank = (a: T) => (a.sortOrder == null ? Number.POSITIVE_INFINITY : a.sortOrder);
  const pinned = (a: T) => { const index = PINNED.indexOf(a.id); return index < 0 ? PINNED.length : index; };
  return installed
    .filter((a) => a.id !== GENERAL_ID)
    .sort((a, b) => pinned(a) - pinned(b) || rank(a) - rank(b));
}

export interface SplitAgents<T> {
  general: T | null;
  visible: T[];
  overflow: T[];
}

/** 传入已安装 agents:抽出 general,营销影像、数字主播优先，其余按 sortOrder 升序(null 最后),
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

export const GENERAL_ID = "general";

export const AGENT_TAB_WINDOW = 2;

export const MAX_VISIBLE_SUBAGENTS = 6;

/** 子 Agent(排除 general)按 sortOrder 升序,null 最后。 */
export function sortedSubAgents<T extends { id: string; sortOrder?: number | null }>(
  installed: T[]
): T[] {
  const rank = (a: T) => (a.sortOrder == null ? Number.POSITIVE_INFINITY : a.sortOrder);
  return installed
    .filter((a) => a.id !== GENERAL_ID)
    .sort((a, b) => rank(a) - rank(b));
}

export interface SplitAgents<T> {
  general: T | null;
  visible: T[];
  overflow: T[];
}

export interface AgentTabView<T> {
  general: T | null;
  visible: T[];
  windowStart: number;
  canPrev: boolean;
  canNext: boolean;
}

/** 传入已安装 agents:抽出 general,子 Agent 按 sortOrder 升序(null 最后),
 *  在子 Agent 上取一个宽度 AGENT_TAB_WINDOW 的滑动窗口。windowStart 会被夹取到
 *  合法区间,并自动跟随 activeId(激活的子 Agent 始终落在窗口内)。 */
export function windowSubAgents<T extends { id: string; sortOrder?: number | null }>(
  installed: T[],
  windowStart: number,
  activeId: string,
): AgentTabView<T> {
  const general = installed.find((a) => a.id === GENERAL_ID) ?? null;
  const subs = sortedSubAgents(installed);

  const maxStart = Math.max(0, subs.length - AGENT_TAB_WINDOW);
  let start = Math.min(Math.max(windowStart, 0), maxStart);

  const activeIdx = subs.findIndex((a) => a.id === activeId);
  if (activeIdx >= 0) {
    if (activeIdx < start) start = activeIdx;
    else if (activeIdx >= start + AGENT_TAB_WINDOW) start = activeIdx - AGENT_TAB_WINDOW + 1;
    start = Math.min(Math.max(start, 0), maxStart);
  }

  return {
    general,
    visible: subs.slice(start, start + AGENT_TAB_WINDOW),
    windowStart: start,
    canPrev: start > 0,
    canNext: start + AGENT_TAB_WINDOW < subs.length,
  };
}

/** 传入已安装 agents:抽出 general,子 Agent 按 sortOrder 升序(null 最后),
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

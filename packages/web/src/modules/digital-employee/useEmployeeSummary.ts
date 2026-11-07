import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/index.js";
import { notifyDesktop } from "../../lib/notify.js";
import { employeeApi } from "./api.js";
import type { AssignmentActivity, TodaySummary } from "./types.js";

const POLL_MS = 60_000;
/** A task needing an answer should reach the desktop in seconds, but only while one could. */
const OPEN_TASKS_POLL_MS = 10_000;
const NOTIFIED_KEY = "lot:employee-brief-notified";
const TASK_CURSOR_KEY = "lot:employee-task-events";

function alreadyNotified(id: string): boolean {
  try { return localStorage.getItem(NOTIFIED_KEY) === id; } catch { return false; }
}

function rememberNotified(id: string) {
  try { localStorage.setItem(NOTIFIED_KEY, id); } catch { /* Storage may be disabled. */ }
}

function readCursor(): string | undefined {
  try { return localStorage.getItem(TASK_CURSOR_KEY) ?? undefined; } catch { return undefined; }
}

function saveCursor(cursor: string) {
  try { localStorage.setItem(TASK_CURSOR_KEY, cursor); } catch { /* Storage may be disabled. */ }
}

const EVENT_TITLES: Record<AssignmentActivity["events"][number]["kind"], string> = {
  finished: "任务没有完成", paused: "任务暂停了", decision: "任务等你决定", reminder: "任务还在等你决定",
};

/** The number on the brand area, the one desktop notification a brief gets per device, and one for each task event. */
export function useEmployeeSummary() {
  const { t } = useI18n();
  const [pending, setPending] = useState(0);
  const [waitingTasks, setWaitingTasks] = useState(0);
  const cursor = useRef(readCursor());

  const announce = useCallback((summary: TodaySummary) => {
    const { brief } = summary;
    if (!brief || brief.readAt || !summary.desktopReminder || brief.counts.pending === 0 || alreadyNotified(brief.id)) return;
    rememberNotified(brief.id);
    const { confirm, followUps, results } = brief.counts;
    notifyDesktop(t("今日简报"), t("待确认 {0} 件，要跟进 {1} 位客户，等结果 {2} 个。", [confirm, followUps, results]));
  }, [t]);

  const announceTasks = useCallback(({ events, cursor: next }: AssignmentActivity) => {
    for (const event of events) notifyDesktop(t(event.status === "succeeded" ? "任务做完了" : EVENT_TITLES[event.kind]), event.title);
    if (next === null) return;
    cursor.current = next;
    saveCursor(next);
  }, [t]);

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    let delay = POLL_MS;
    const load = async () => {
      if (document.visibilityState === "hidden" && !window.lotDesktop) return;
      const summary = await employeeApi.getTodaySummary(cursor.current).catch(() => null);
      if (!live || !summary) return;
      setPending(summary.pending);
      setWaitingTasks(summary.assignments.waiting);
      delay = summary.assignments.open > 0 ? OPEN_TASKS_POLL_MS : POLL_MS;
      announce(summary);
      announceTasks(summary.assignments);
    };
    const tick = () => {
      void load().finally(() => { if (live) timer = window.setTimeout(tick, delay); });
    };
    const onFocus = () => void load();
    tick();
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [announce, announceTasks]);

  return { pending, setPending, waitingTasks };
}

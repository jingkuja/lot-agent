import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n/index.js";
import { notifyDesktop } from "../../lib/notify.js";
import { employeeApi } from "./api.js";
import type { TodaySummary } from "./types.js";

const POLL_MS = 60_000;
const NOTIFIED_KEY = "lot:employee-brief-notified";

function alreadyNotified(id: string): boolean {
  try { return localStorage.getItem(NOTIFIED_KEY) === id; } catch { return false; }
}

function rememberNotified(id: string) {
  try { localStorage.setItem(NOTIFIED_KEY, id); } catch { /* Storage may be disabled. */ }
}

/** The number on the brand area, and the one desktop notification a brief gets per device. */
export function useEmployeeSummary(enabled: boolean) {
  const { t } = useI18n();
  const [pending, setPending] = useState(0);

  const announce = useCallback((summary: TodaySummary) => {
    const { brief } = summary;
    if (!brief || brief.readAt || !summary.desktopReminder || brief.counts.pending === 0 || alreadyNotified(brief.id)) return;
    rememberNotified(brief.id);
    const { confirm, followUps, results } = brief.counts;
    notifyDesktop(t("今日简报"), t("待确认 {0} 件，要跟进 {1} 位客户，等结果 {2} 个。", [confirm, followUps, results]));
  }, [t]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => {
      if (document.visibilityState === "hidden" && !window.lotDesktop) return;
      void employeeApi.getTodaySummary().then((summary) => {
        if (!live) return;
        setPending(summary.pending);
        announce(summary);
      }).catch(() => {});
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [enabled, announce]);

  return { pending, setPending };
}

import { useEffect, useRef } from "react";

/**
 * Repeats `load` while enabled, waiting for each round to finish. A hidden page stops asking and catches up
 * as soon as it is shown again, so background tabs do not use up the account's request limit.
 */
export function usePolling(load: () => Promise<unknown>, intervalMs: number, enabled: boolean) {
  const latest = useRef(load);
  useEffect(() => { latest.current = load; });

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let running = false;
    let timer: number | undefined;
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      running = true;
      await latest.current().catch(() => undefined);
      running = false;
      if (live) timer = window.setTimeout(tick, intervalMs);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden" || running) return;
      window.clearTimeout(timer);
      void tick();
    };
    timer = window.setTimeout(tick, intervalMs);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      live = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, intervalMs]);
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { MarketingTaskState } from "@lot-agent/core/marketing-video";
import { request } from "../../api/client.js";

export interface DraftSession {
  /** Mark the start of async work; pass the value to `current` before applying its result. */
  token(): number;
  /** Invalidate all work in flight, e.g. when another draft is opened. */
  next(): number;
  /** False after unmount or after `next`, so a late result never lands in another draft. */
  current(token: number): boolean;
  readonly alive: boolean;
}

export function useDraftSession(): DraftSession {
  const state = useRef({ epoch: 0, alive: true });
  useEffect(() => {
    const value = state.current;
    value.alive = true;
    return () => { value.alive = false; value.epoch++; };
  }, []);
  return useMemo(() => ({
    token: () => state.current.epoch,
    next: () => ++state.current.epoch,
    current: (token: number) => state.current.alive && token === state.current.epoch,
    get alive() { return state.current.alive; },
  }), []);
}

/** One user action at a time across buttons, uploads and pickers. A second start while
 * one runs is ignored, so a double click never sends a paid request twice. */
export function useExclusive(session: DraftSession) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  return {
    busy,
    get locked() { return lock.current; },
    async run(work: () => Promise<void>) {
      if (lock.current) return;
      lock.current = true; setBusy(true);
      try { await work(); }
      finally { lock.current = false; if (session.alive) setBusy(false); }
    },
  };
}

export const POLL_MIN_MS = 2500;
export const POLL_MAX_MS = 15000;

/** Poll a running video's task state. The interval grows while nothing changes, and a
 * hidden tab stops polling until it is shown again. */
export function useTaskPolling(projectId: string | undefined, active: boolean, onState: (state: MarketingTaskState) => void, onError: (failed: boolean) => void) {
  const callbacks = useRef({ onState, onError });
  callbacks.current = { onState, onError };
  useEffect(() => {
    if (!active || !projectId) return;
    let stopped = false; let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_MIN_MS; let last = "";
    const schedule = (ms: number) => { clearTimeout(timer); if (!stopped) timer = setTimeout(() => void poll(), ms); };
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const state = await request<MarketingTaskState>(`/marketing-videos/${projectId}/status`);
        if (stopped) return;
        const fingerprint = JSON.stringify([state.status, state.progress, state.stage]);
        delay = fingerprint === last ? Math.min(Math.round(delay * 1.5), POLL_MAX_MS) : POLL_MIN_MS;
        last = fingerprint;
        callbacks.current.onState(state); callbacks.current.onError(false);
      } catch { if (!stopped) callbacks.current.onError(true); }
      finally { inFlight = false; }
      schedule(delay);
    };
    const shown = () => { if (document.visibilityState === "visible" && !inFlight) schedule(0); };
    document.addEventListener("visibilitychange", shown);
    schedule(1000);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", shown); };
  }, [active, projectId]);
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComicDramaClipDraft, ComicDramaDetail } from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { comicDramaApi } from "./api.js";

type PendingClip = { draft: ComicDramaClipDraft; revision: number };
type PendingScript = { content: string; revision: number };
type Issue = { kind: "conflict" | "failed"; target: string };
type Editor = {
  detail: ComicDramaDetail | null;
  clips: Record<string, PendingClip>;
  script?: PendingScript;
  issue?: Issue;
  saving: boolean;
};

const initial: Editor = { detail: null, clips: {}, saving: false };
const dirty = (editor: Editor) => !!editor.script || Object.keys(editor.clips).length > 0;

export function useComicDramaDraft() {
  const state = useRef<Editor>(initial);
  const alive = useRef(true);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const [editor, setEditor] = useState(initial);

  const commit = useCallback((next: Editor) => {
    state.current = next;
    if (alive.current) setEditor(next);
  }, []);
  useEffect(() => {
    alive.current = true;
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty(state.current)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => { alive.current = false; window.removeEventListener("beforeunload", warn); };
  }, []);

  const load = useCallback((detail: ComicDramaDetail | null) => commit({ ...initial, detail }), [commit]);
  const editClip = (id: string, draft: ComicDramaClipDraft) => {
    const next = state.current;
    const revision = next.clips[id]?.revision ?? next.detail?.clips.find(clip => clip.id === id)?.revision;
    if (revision) commit({ ...next, clips: { ...next.clips, [id]: { draft, revision } } });
  };
  const editScript = (content: string) => {
    const next = state.current;
    const revision = next.script?.revision ?? next.detail?.series.revision;
    if (revision) commit({ ...next, script: { content, revision } });
  };

  const flush = useCallback((retry = false): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const start = state.current;
    if (!start.detail || !dirty(start)) return Promise.resolve(true);
    if (start.issue && (!retry || start.issue.kind === "conflict")) return Promise.resolve(false);
    const id = start.detail.series.id;
    commit({ ...start, saving: true, issue: undefined });
    const save = async () => {
      let target = "";
      try {
        while (alive.current && dirty(state.current)) {
          const snapshot = state.current;
          const detail = snapshot.detail!;
          const first = Object.entries(snapshot.clips)[0];
          if (first) {
            const [clipId, pending] = first;
            target = clipId;
            const draft = { ...pending.draft, lines: pending.draft.lines.map(line => ({ ...line, speaker: line.speaker?.trim() || null })) };
            const result = await comicDramaApi.saveClip(id, clipId, draft, pending.revision);
            const current = state.current;
            const clips = { ...current.clips };
            if (clips[clipId] === pending) delete clips[clipId];
            else if (clips[clipId]) clips[clipId] = { ...clips[clipId], revision: result.clip.revision };
            // A jump signals another tab's write. Keep the older parent revision for order/script CAS.
            const ownRevision = result.seriesRevision === detail.series.revision + 1 ? result.seriesRevision : detail.series.revision;
            const script = current.script?.revision === detail.series.revision ? { ...current.script, revision: ownRevision } : current.script;
            commit({ ...current, clips, script, detail: {
              ...detail,
              series: { ...detail.series, revision: ownRevision },
              clips: detail.clips.map(clip => clip.id === clipId ? { ...result.clip, ordinal: clip.ordinal } : clip),
            } });
          } else if (snapshot.script) {
            target = "script";
            const pending = snapshot.script;
            const result = await comicDramaApi.saveScript(id, pending.content, pending.revision);
            const current = state.current;
            const script = current.script === pending || !current.script ? undefined : { ...current.script, revision: result.seriesRevision };
            commit({ ...current, script, detail: { ...detail, clips: result.clips, script: result.script,
              series: { ...detail.series, revision: result.seriesRevision } } });
          }
        }
        return true;
      } catch (error) {
        const kind = error instanceof ApiClientError && [404, 409].includes(error.status) ? "conflict" : "failed";
        commit({ ...state.current, issue: { kind, target } });
        return false;
      } finally {
        commit({ ...state.current, saving: false });
        inFlight.current = null;
      }
    };
    inFlight.current = save();
    return inFlight.current;
  }, [commit]);

  useEffect(() => {
    if (!dirty(editor) || editor.issue || editor.saving) return;
    const timer = window.setTimeout(() => void flush(), 650);
    return () => window.clearTimeout(timer);
  }, [editor, flush]);

  const reapply = (latest: ComicDramaDetail) => {
    const next = state.current;
    if (next.issue?.kind !== "conflict" || next.detail?.series.id !== latest.series.id || latest.series.archivedAt) return;
    const target = next.issue.target;
    const clip = latest.clips.find(entry => entry.id === target);
    if (target !== "script" && (!clip || !next.clips[target])) return;
    const clips = target === "script" ? next.clips : { ...next.clips, [target]: { ...next.clips[target], revision: clip!.revision } };
    const script = target === "script" && next.script ? { ...next.script, revision: latest.series.revision } : next.script;
    commit({ ...next, detail: latest, clips, script, issue: undefined });
  };

  const getDetail = useCallback(() => state.current.detail, []);
  return { editor, flush, load, editClip, editScript, reapply, dirty: dirty(editor), getDetail };
}

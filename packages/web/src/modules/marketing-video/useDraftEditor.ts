import { useEffect, useRef, useState } from "react";
import { newMarketingDraft, storyboardScript, type MarketingDraft, type MarketingShot, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { errorMessage, json, requestProject, type Project } from "./api.js";
import { withDraftField } from "./draft-editor.js";
import type { DraftSession } from "./session.js";

/** The open draft and the last state the server confirmed for it. Async work reads the refs, so a
 * result that arrives after later edits still sees the current draft. */
export function useDraftEditor({ ownerId, session, profile, onEdit, onProject }: {
  ownerId: string; session: DraftSession; profile: MarketingVideoProfile;
  /** Called on every edit, e.g. to clear the last error and notice. */
  onEdit(): void;
  /** Called with every project the editor accepts, e.g. to keep the draft list current. */
  onProject(project: Project): void;
}) {
  const [draft, setDraft] = useState<MarketingDraft>(() => newMarketingDraft());
  const [project, setProject] = useState<Project | null>(null);
  const [saving, setSaving] = useState(false);
  const draftRef = useRef(draft);
  const projectRef = useRef<Project | null>(null);
  // Identity of the open draft and the last state the server confirmed.
  const draftId = useRef<string>(crypto.randomUUID());
  const version = useRef(0);
  const saved = useRef(JSON.stringify(draft));
  const flight = useRef<Promise<Project> | null>(null);
  const storageKey = `lot:marketing-video:${ownerId}`;
  const dirty = JSON.stringify(draft) !== saved.current;

  /** Show a project the server returned, unless it is older than one already shown for this draft. */
  function setCurrent(p: Project) {
    if (p.id === draftId.current && p.version < version.current) return;
    projectRef.current = p; setProject(p); onProject(p);
  }
  /** Remember the open draft for the next visit; the browser may refuse storage. */
  function remember(id: string | null) {
    try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey); } catch { /* Server drafts remain available. */ }
  }
  function update(next: MarketingDraft) {
    draftRef.current = next; setDraft(next); onEdit();
  }
  /** Show a project the server returned as the saved state of the editor. */
  function load(p: Project) {
    version.current = p.version; saved.current = JSON.stringify(p.draft);
    update(p.draft); setCurrent(p);
  }
  function field<K extends keyof MarketingDraft>(name: K, value: MarketingDraft[K]) {
    update(withDraftField(draftRef.current, name, value, profile));
  }
  /** Shot edits are also edits of the copy. */
  const setShots = (storyboard: MarketingShot[]) => update({ ...draftRef.current, storyboard, script: storyboardScript(storyboard) });
  /** Save the current draft; a save already in flight finishes first, an unchanged draft is not sent. */
  async function save(): Promise<Project> {
    if (flight.current) { await flight.current; return save(); }
    if (saved.current === JSON.stringify(draftRef.current) && projectRef.current) return projectRef.current;
    const token = session.token(); const snapshot = draftRef.current;
    setSaving(true);
    const pending = requestProject(`/marketing-videos/${draftId.current}`, json("PUT", { version: version.current, draft: snapshot }));
    flight.current = pending;
    try {
      const p = await pending;
      if (session.current(token)) { version.current = p.version; saved.current = JSON.stringify(snapshot); setCurrent(p); remember(p.id); }
      return p;
    } finally {
      if (flight.current === pending) flight.current = null;
      // Saves never overlap, so this one ending clears the flag even after another draft opened.
      if (session.alive) setSaving(false);
    }
  }
  /** Start an unsaved draft: empty, or a copy of the current content. */
  function reset(copy = false): MarketingDraft {
    draftId.current = crypto.randomUUID(); version.current = 0; projectRef.current = null;
    setProject(null);
    const next = copy ? { ...draftRef.current } : newMarketingDraft();
    saved.current = copy ? "" : JSON.stringify(next);
    update(next); remember(null);
    return next;
  }
  return { draft, project, saving, dirty, storageKey, draftRef, projectRef, draftId, version, saved, flight,
    setCurrent, remember, update, load, field, setShots, save, reset };
}
export type DraftEditor = ReturnType<typeof useDraftEditor>;

/** Save edits shortly after they stop, while nothing else runs, and tell the workspace whether
 * leaving would lose work. */
export function useDraftAutosave(editor: DraftEditor, { session, ready, busy, onError, onDraftChange }: {
  session: DraftSession; ready: boolean; busy: boolean; onError(message: string): void; onDraftChange?: (dirty: boolean) => void;
}) {
  const { draft, dirty, saving } = editor;
  useEffect(() => {
    if (!ready || busy || !dirty) return;
    const timer = setTimeout(() => { void editor.save().catch(e => { if (session.alive) onError(errorMessage(e)); }); }, 900);
    return () => clearTimeout(timer);
  }, [draft, ready, busy]);
  useEffect(() => { onDraftChange?.(dirty || saving || busy); return () => onDraftChange?.(false); }, [dirty, saving, busy, onDraftChange]);
}

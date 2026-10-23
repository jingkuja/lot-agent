/** The latest recorded text request of a draft (copy, storyboard, check, titles), as the server lists it. */
export interface TextOperationState {
  id: string;
  kind?: string;
  status: string;
  appliedVersion?: number;
  result?: { analysis?: string };
}

/** How the studio reacts to the latest text request of the open draft. `version` and `dirty` describe
 * the editor; `reviewShown` tells whether the editor already shows the review of its draft. */
export function textOperationEffect(operation: TextOperationState | undefined, editor: { version: number; dirty: boolean; reviewShown: boolean }) {
  const status = operation?.status ?? "";
  const applied = operation?.appliedVersion ?? 0;
  return {
    /** Editing stays locked: the request runs, its result is unknown, or a received result is being filled in. */
    pending: ["running", "unknown", "needs_apply"].includes(status),
    /** The result is unknown: the studio shows the choices instead of "processing". */
    unknown: status === "unknown",
    /** The request ended without a result to replay, so the next request needs a new ID. */
    newRequestId: ["failed", "cancelled", "released"].includes(status),
    /** A saved result is newer than the editor, or a recovered check of this version is not shown yet. */
    reload: status === "succeeded" && applied > 0 && !editor.dirty
      && (applied > editor.version || (operation?.kind === "review" && applied === editor.version && !editor.reviewShown)),
  };
}

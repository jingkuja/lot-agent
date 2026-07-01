/**
 * Scroll-driven pagination breaks when a paginated list is filtered client-side:
 * if the visible rows don't overflow their container there is nothing to scroll,
 * so the scroll handler never fires `loadMore` and later pages — which may hold
 * the only rows matching the active filter — stay unreachable.
 *
 * This returns true when the next page must be fetched proactively: more pages
 * exist, none is already in flight, and the current content does not overflow
 * (so no scroll event can ever be produced). Callers keep invoking it after each
 * page until the content overflows (restoring the scroll escape hatch) or there
 * are no more pages.
 */
export function shouldAutoLoadMore(params: {
  hasMore: boolean;
  loadingMore: boolean;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  const { hasMore, loadingMore, scrollHeight, clientHeight } = params;
  if (!hasMore || loadingMore) return false;
  // Not scrollable ⇒ scroll-based loadMore can never fire ⇒ fetch proactively.
  return scrollHeight <= clientHeight;
}

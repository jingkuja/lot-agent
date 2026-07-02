# Sidebar agent tab strip: native horizontal scroll

Date: 2026-07-02
Area: `packages/web`

## Problem

`SidebarAgentTabs` pages sub-agent tabs through a 2-wide window (`windowSubAgents` +
`‹`/`›` arrows). `windowSubAgents` also force-snaps the window so the active sub-agent
always stays visible (`agent-order.ts:38-43`). The two rules fight: when the active tab
sits at the left edge of the window (e.g. 图片生成), clicking `›` bumps `windowStart`,
and the very next render snaps it back — the arrow appears dead. Structurally, you can
never scroll the active tab out of view, so you can never page past it.

## Goal

Replace the windowed paging with a native horizontally scrollable tab strip. Manual
scrolling and active-tab following stop being mutually exclusive: following happens only
at the moment the active agent *changes*; manual scrolling is never clamped back.

Non-goals: no change to the above-input pill row, the non-destructive switching state
model (`activeAgentId`/`openAgentId`), the agent center, or any server code.

## Design

### `SidebarAgentTabs.tsx`

- 通用助手 stays pinned first, outside the scroll container (unchanged).
- Sub-agents render inside a new `.agent-tab-strip` container: `overflow-x: auto`,
  scrollbar hidden, CSS mask fade at both edges.
- `‹` / `›` arrows are kept but become smooth scroll nudges:
  `strip.scrollBy({ left: ±0.8 * clientWidth, behavior: "smooth" })`.
  - Rendered only when content actually overflows (`scrollWidth > clientWidth`,
    tracked with a `ResizeObserver` on the strip).
  - Disabled at the corresponding edge; `canPrev`/`canNext` state updated from the
    strip's `scroll` event (`scrollLeft > 0` / `scrollLeft + clientWidth < scrollWidth`,
    with a small epsilon for fractional pixels).
- Active-tab following: a `useEffect` keyed on `activeId` calls
  `scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" })` on the
  active tab's element (ref). This fires only when the active agent changes (tab click
  or a switch from the above-input pill row), so it never fights manual scrolling.

### `lib/agent-order.ts`

- Delete `windowSubAgents`, `AGENT_TAB_WINDOW`, and `AgentTabView` (sole consumer was
  `SidebarAgentTabs`), plus their tests.
- Extract the duplicated "find `general`, sort sub-agents by `sortOrder` ascending with
  `null` last" logic into `sortedSubAgents(installed)`; `splitInstalledAgents` and
  `SidebarAgentTabs` both use it.

### `App.css`

- New `.agent-tab-strip` rules: flex row, `overflow-x: auto`, hidden scrollbar
  (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`), `mask-image`
  linear-gradient fade at both edges. Existing `var(--*)` tokens only — no hardcoded
  colors.
- Tabs inside the strip switch from `flex: 1 1 0` (equal share) to `flex: 0 0 auto`
  with a fixed min-width so they can overflow.
- Tab hover uses `translateY(-2px)`; the scroll container would clip it. Compensate
  with vertical padding on the strip cancelled by negative margins, preserving the
  lift effect.

## Testing

- Vitest (TDD): `sortedSubAgents` cases — `general` extracted; sub-agents sorted by
  `sortOrder` with `null` last. Update `agent-order.test.ts`: remove `windowSubAgents`
  cases, keep `splitInstalledAgents` cases (now delegating to the shared sort).
- Manual (layout behavior, not testable in jsdom): strip scrolls freely; arrows appear
  only on overflow, gray out at edges, and nudge-scroll; switching agent from a tab or
  the above-input pill row smooth-scrolls the active tab into view; hover lift is not
  clipped; edge fade renders in light and dark themes.

## Out of scope

Above-input pill row, `activeAgentId`/`openAgentId` switching semantics, agent center,
server/API.

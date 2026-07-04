# Above-input agent pills + non-destructive tab switching

Date: 2026-07-01
Area: `packages/web`

## Problem

Commit `6caaf5b` moved agent switching into the sidebar (`SidebarAgentTabs`, `<`/`>`
2-window paging) and deleted the above-input `AgentSwitcher` / `AgentOverflowPopover`
/ `splitInstalledAgents`. We want the above-input pill row back (max 6 visible + a
更多 popup), **in addition to** the sidebar tabs. Separately, switching an agent tab
currently clears the open conversation and drops into a new-chat state — that is too
destructive.

## Goals

1. **Restore the above-input pill row** with the old max-6 + 更多 popup behavior, reusing
   the existing shared icon map. Sidebar tabs stay (keep both switchers).
2. **Tab switching becomes non-destructive**: switching a tab while a conversation is
   open must not change the on-screen chat. `新对话` starts a fresh chat on the *open
   chat's* agent, not the highlighted tab.

Non-goals: no change to the sidebar windowed tabs, agent center, or any server code.

## Requirement 1 — restore the pill row

Restore three deleted pieces (see `git show 6caaf5b^:...`):

- **`components/AgentSwitcher.tsx`** — pills row. `general` pinned first; sub-agents via
  `splitInstalledAgents` → first `MAX_VISIBLE_SUBAGENTS` (6) visible, remainder in a 更多
  overflow popover. **Change from the old version:** drop its inline `ICONS` map and use
  the shared `lib/agent-icons.ts` (`AGENT_ICONS`, `agentIconKind`) — consistent with
  `SidebarAgentTabs`. Props: `agents`, `activeId`, `onSwitch`, `onPickOverflow`, `disabled`.
- **`components/AgentOverflowPopover.tsx`** — restored as-is (click-outside closes, lists
  overflow agents, `onPick`).
- **`lib/agent-order.ts`** — re-add `MAX_VISIBLE_SUBAGENTS = 6` and `splitInstalledAgents`
  alongside the existing `windowSubAgents` (both coexist; sidebar keeps using `windowSubAgents`).
  Restore the corresponding cases in `lib/agent-order.test.ts`.
- **`App.css`** — restore the `.input-switcher`, `.agent-switcher`, `.agent-pill*`,
  `.agent-more*`, `.agent-overflow-*` block from `6caaf5b^` (all `var()` tokens — verify
  `--agent-icon-general/image/video` still exist; they do, shared with the sidebar tabs).

Render path: `ChatPanel` gains back an `inputAbove?: React.ReactNode` prop, rendered as
`{inputAbove && <div className="input-switcher">{inputAbove}</div>}` inside the shared
`inputEl` (so it shows in both the empty hero and an active conversation). `Workspace`
builds the `<AgentSwitcher .../>` element and passes it as `inputAbove`.

## Requirement 2 — non-destructive switching (state model)

Decouple "which tab is highlighted / filters the sidebar" from "which agent the on-screen
chat belongs to".

- `activeAgentId` — **navigation only**: highlighted tab (pills + sidebar) and the sidebar
  conversation-list filter.
- New derived value `openAgentId = newAgentId ?? conversations.find(c => c.id === activeId)?.agent_id ?? defaultAgentId`.
  This is the agent of the chat currently on screen and drives:
  - `ChatPanel` `agent` prop (hero title/desc),
  - input mode (`image`/`video`/`default`) in `doSend` and `ChatPanel`,
  - model catalog selection,
  - preview eligibility (copywriting).
  These read `activeAgentId` today → switch them to `openAgentId`.

### Behaviors

- **`handleSwitchAgent(agentId)`**
  - If `newAgentId != null` (empty/new-chat hero): retarget the pending chat →
    `setNewAgentId(agentId); setActiveAgentId(agentId)`. Hero switches agent; nothing
    committed is lost.
  - Else (a real conversation is open): `setActiveAgentId(agentId)` **only**. Do not touch
    `activeId`, `newAgentId`, `messages`, or preview. Chat stays; sidebar filters + tab
    re-highlights.
- **`handleCreate` (新对话)** — guard `if (newAgentId) return`. Otherwise start a new chat on
  the open chat's agent: `const a = openAgentId; setNewAgentId(a); setActiveAgentId(a);
  setActiveId(null); clear(); setPreviewContent(null);`.
- **`handleSelect(id)`** — unchanged: opening a conversation syncs `setActiveAgentId(conv.agent_id)`,
  `newAgentId = null`, loads messages.
- **`handlePickOverflow(agentId)`** — restore old logic: `await promote(agentId)` then
  `handleSwitchAgent(agentId)`. (`promote` still exists on `useAgents` / `api.promoteAgent`.)
- **`handleDelete` / `handleUninstall`** — keep using `activeAgentId` for the fallback
  new-chat agent (unchanged).

### Accepted edge cases

- After switching the tab while a real conversation stays open, `activeAgentId` may differ
  from the open conversation's agent; the sidebar list (filtered by `activeAgentId`) then
  won't contain the open conversation, so no sidebar row is highlighted. Acceptable.
- The pill row also renders above the input during an active conversation (matches old
  behavior). If undesired, gate it to the empty state — deferred unless requested.

## Testing

- `agent-order.test.ts`: restore `splitInstalledAgents` cases (general extracted; sub-agents
  sorted by `sortOrder` with null last; first 6 visible, remainder overflow). Keep existing
  `windowSubAgents` tests.
- Manual: pills appear above input in hero + conversation; 更多 popup lists overflow and
  promotes on pick; switching a tab mid-conversation leaves the chat untouched and only
  filters the sidebar; 新对话 opens on the open chat's agent.

## Out of scope

Server/API changes, sidebar windowed-tab changes, agent center, theming tokens.

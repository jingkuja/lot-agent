# Sidebar Agent Tabs — Design Spec

**Date:** 2026-07-01
**Status:** Approved, ready for implementation plan
**Area:** `packages/web`

## Problem

The conversation sidebar tags every conversation item with a colored per-agent
label (标识) at the end of the row (`agent-tag` in `Sidebar.tsx`). Agent
switching lives in a *separate* place — the `AgentSwitcher` pill row above the
chat input. This is redundant and the per-conversation tag adds visual noise.

Replace the per-conversation tag with an **agent tab bar at the top of the
sidebar**. Tabs both **filter** the conversation list to the selected agent and
**switch** the active agent. The old `AgentSwitcher` above the input is removed —
the sidebar tab bar becomes the single agent entry point.

## Goals

- Sidebar top gets an agent tab bar; `通用` pinned first and default-selected.
- Only **2 additional installed tabs** visible at once; `< >` arrows page a
  sliding window over the remaining installed sub-agents.
- Tabs exist **only for installed agents**.
- Clicking a tab filters the list to that agent's conversations **and** switches
  the active agent (reusing existing `handleSwitchAgent`, which enters new-chat
  mode).
- Remove the per-conversation `agent-tag`.
- Remove the `AgentSwitcher` pill row above the chat input.
- Style follows the reference: compact icon-above-label tabs, active tab gets a
  highlight pill; all colors via existing `var(--*)` tokens.

## Non-goals

- Server-side per-agent conversation filtering (list filtering is client-side).
- Changing the Agent Center install/uninstall flow (stays in `BrandHeader`).
- Any backend / API changes.

## Layout

```
┌─ sidebar ─────────────────────────┐
│  [通用] < [图片生成] [视频制作] >   │  ← NEW agent tab bar
│  历史对话              ＋ 新对话     │  ← header (renamed)
│  ──────────────────────────────    │
│  会话标题一                     x   │  ← list item, NO agent tag
│  会话标题二                     x   │
└────────────────────────────────────┘
```

- `通用` pinned first, always visible, default-selected.
- Visible window = `通用` + up to 2 sub-agents.
- `<` / `>` arrows page the sub-agent window; shown only when there are **>2**
  installed sub-agents.
- Window **auto-follows the active tab**: if the active sub-agent is outside the
  current window, the window shifts so it is visible.
- Header renamed: `最近对话` → `历史对话`; `新会话` button → `新对话`.

## Behavior

- **Tab click**: calls `handleSwitchAgent(agentId)` (existing) — switches active
  agent + enters new-chat mode. The sidebar list is filtered to
  `conv.agent_id === activeAgentId`. The virtual `新对话` entry has
  `agent_id === newAgentId === activeAgentId`, so it stays visible under the
  selected tab.
- **Disabled while streaming** (`isStreaming`), matching the old switcher.
- **Filtering is client-side** over already-loaded pages:
  `conversations.filter(c => c.agent_id === activeAgentId)`. Server keyset
  pagination stays agent-agnostic — a filtered view may show fewer rows until
  more pages load on scroll. **Known limitation**, server-side per-agent
  filtering deferred.

## Sliding-window paging model

Pure helper over the installed sub-agents (general excluded), sorted by
`sortOrder` (nulls last):

```
input:  subAgents: Agent[], windowStart: number, activeId: string, WINDOW = 2
output: { visible: Agent[], canPrev: boolean, canNext: boolean, windowStart: number }
```

- `visible = subAgents.slice(windowStart, windowStart + WINDOW)`
- `canPrev = windowStart > 0`
- `canNext = windowStart + WINDOW < subAgents.length`
- **Auto-follow**: if `activeId` is a sub-agent at index `i` and `i` is outside
  `[windowStart, windowStart + WINDOW)`, clamp `windowStart` so `i` is included
  (`windowStart = min(i, subAgents.length - WINDOW)` when `i` past the end,
  `windowStart = i` when `i` before the start), floored at 0.
- `<` → `windowStart = max(0, windowStart - 1)`;
  `>` → `windowStart = min(subAgents.length - WINDOW, windowStart + 1)`.

`general` is never part of the window (always rendered first, pinned).

## Components / files

**New**
- `packages/web/src/components/SidebarAgentTabs.tsx` — the tab bar: pinned
  `通用` + windowed sub-agent tabs + `< >` arrows. Props: `agents` (installed),
  `activeId`, `onSwitch`, `disabled`.
- `packages/web/src/lib/agent-icons.tsx` — extracted `ICONS` map + `kindOf`
  (moved out of `AgentSwitcher.tsx`).
- Paging helper — add to `packages/web/src/lib/agent-order.ts` (e.g.
  `windowSubAgents`) with a colocated `*.test.ts`.

**Changed**
- `packages/web/src/components/Sidebar.tsx` — render `SidebarAgentTabs` at top;
  remove `agent-tag` span + `TAG_BY_TYPE` + `tagFor`; rename header label. New
  props for the tab bar (installed agents, `activeAgentId`, `onSwitchAgent`,
  `disabled`).
- `packages/web/src/pages/Workspace.tsx` — remove `AgentSwitcher` import +
  `switcher` + `inputAbove`; pass tab-bar props to `Sidebar`; filter
  `sidebarConversations` by `activeAgentId`.
- `packages/web/src/components/ChatPanel.tsx` — remove the now-unused
  `inputAbove` prop and its `.input-switcher` wrapper.
- `packages/web/src/App.css` — add `.sidebar-agent-tabs` styles (via `var(--*)`);
  retire `.agent-switcher` / `.agent-pill` / `.agent-tag` / `.input-switcher`
  styles.

**Deleted**
- `packages/web/src/components/AgentSwitcher.tsx`
- `packages/web/src/components/AgentOverflowPopover.tsx`
- `splitInstalledAgents` in `agent-order.ts` (usage removed) — remove or leave
  unused; prefer removing with its test if no longer referenced.

## Testing

- **Unit (Vitest)** for the paging helper: window contents, `<`/`>` clamping at
  both ends, auto-follow-active (active before window / after window / general).
- **Manual**: tab click filters list + switches agent; `< >` paging; `新对话`
  entry appears under the correct tab; tabs disabled while streaming; light &
  dark theme render correctly.

## Risks / notes

- Client-side filtering over paginated data (documented limitation above).
- Narrow sidebar width: 通用 + 2 tabs + 2 arrows must fit; compact
  icon-above-label sizing keeps it within the sidebar column.

# Decouple pill row from sidebar tabs: pill = new chat, tab = filter only

Date: 2026-07-02
Area: `packages/web` (only `pages/Workspace.tsx`)

## Problem

The above-input pill row (`AgentSwitcher`) and the sidebar tabs (`SidebarAgentTabs`)
currently share one handler (`handleSwitchAgent`) and one highlight source
(`activeAgentId`). The product intent is that they are fully independent:

- **Sidebar tabs** only filter which agent's conversation history is listed.
- **Pills** start a new conversation on the clicked agent.
- **新对话 button** always starts a new conversation on the default 通用 agent.

Today, pills only re-filter the sidebar (or retarget the hero), 新对话 opens on the
open chat's agent, and sidebar tabs retarget the hero when in new-chat state.

## Behaviors

1. **Pill click** (and 更多 overflow pick, after `promote`): enter the new-chat hero
   for that agent unconditionally — `setNewAgentId(agentId); setActiveId(null);
   clear(); setPreviewContent(null)`. Do **not** touch `activeAgentId` (sidebar
   filter/highlight stays where it was). Open conversations are persisted, so
   nothing is lost. Clicking the pill of the currently open chat's agent also
   starts a fresh chat (that is the point of the pill).
2. **Pill highlight**: driven by `openAgentId` (the agent of the on-screen chat /
   hero), no longer by `activeAgentId`.
3. **新对话 button**: always `setNewAgentId(defaultAgentId)` (通用) +
   `setActiveId(null); clear(); setPreviewContent(null)`. Remove the
   `if (newAgentId) return` guard — clicking it from a non-general hero switches
   to the general hero. Do **not** touch `activeAgentId`.
4. **Sidebar tab click**: pure filter — `setActiveAgentId(agentId)` only, in every
   state. Remove the hero-retarget branch from the current `handleSwitchAgent`.
5. **Unchanged**: `handleSelect` (opening a conversation still syncs the sidebar
   filter to that conversation's agent and loads it), streaming disable, `promote`
   persistence, `openAgentId` derivation, `doSend`.

## Implementation shape

In `Workspace.tsx`: split `handleSwitchAgent` into

- `handleFilterAgent(agentId)` — sidebar tabs (`Sidebar` `onSwitchAgent`):
  `setActiveAgentId(agentId)`.
- `handleStartNewChat(agentId)` — pills (`AgentSwitcher` `onSwitch`; also the tail
  of `handlePickOverflow` after `promote`, and `handleCreate` calls it with
  `defaultAgentId`).

`AgentSwitcher` props change to `activeId={openAgentId}` and
`onSwitch={handleStartNewChat}`. No component/API/CSS changes.

## Testing

No new unit surface (handlers are UI glue wiring existing state setters; the repo
has no Workspace tests). Verify with `npm run build -w @lot-agent/web` + manual:

- Mid-conversation, click 图片生成 pill → image hero opens, sidebar list still
  shows the previously filtered agent's history, sidebar highlight unmoved.
- 新对话 from a video hero or an open image chat → general hero; sidebar filter
  unmoved.
- Sidebar tab click in hero and in-conversation states → only the list changes.
- Pill highlight follows the open chat/hero agent, not the sidebar tab.

## Out of scope

Server/API, `AgentSwitcher`/`SidebarAgentTabs` components, CSS, the scroll-strip
feature (previous spec), `handleDelete`/`handleUninstall` fallbacks.

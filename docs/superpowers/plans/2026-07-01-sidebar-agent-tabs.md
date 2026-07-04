# Sidebar Agent Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-conversation agent tag and the above-input `AgentSwitcher` with an agent tab bar at the top of the sidebar that both filters the conversation list and switches the active agent.

**Architecture:** A pure sliding-window helper (`windowSubAgents`) drives a new `SidebarAgentTabs` component (pinned `通用` + up to 2 windowed sub-agent tabs + `< >` arrows). `Sidebar` renders it at top and drops the per-row tag; `Workspace` filters the sidebar list by the active agent and wires the tab bar to the existing `handleSwitchAgent`; `ChatPanel` loses its `inputAbove` slot. The old `AgentSwitcher`/`AgentOverflowPopover` are deleted.

**Tech Stack:** React 19 + TypeScript (ESM, explicit `.js` import suffixes), Vitest, CSS variables in `App.css`.

## Global Constraints

- ESM imports use explicit `.js` suffixes (e.g. `from "./agent-order.js"`). 2-space indent.
- All colors via existing `var(--*)` tokens in `App.css` — never hardcode hex/`rgba` (light mode breaks otherwise).
- TDD with Vitest for pure logic; tests colocated as `*.test.ts`.
- `Agent` shape (from `packages/web/src/api/client.ts`): `{ id: string; name: string; type: string; description: string; defaultModelId: string; toolNames: string[]; category?: string; installed?: boolean; sortOrder?: number | null }`.
- `GENERAL_ID = "general"` stays exported from `lib/agent-order.ts` (imported by `Workspace.tsx` and `AgentCenterModal.tsx`).
- Run web tests with: `npm test -w @lot-agent/web`. Type-check/build with: `npm run build -w @lot-agent/web`.

---

### Task 1: Sliding-window paging helper

**Files:**
- Modify: `packages/web/src/lib/agent-order.ts`
- Test: `packages/web/src/lib/agent-order.test.ts` (append new cases; leave existing `splitInstalledAgents` cases untouched — they are removed in Task 4)

**Interfaces:**
- Consumes: `GENERAL_ID` (already in this file).
- Produces:
  ```ts
  export const AGENT_TAB_WINDOW = 2;
  export interface AgentTabView<T> {
    general: T | null;
    visible: T[];        // up to AGENT_TAB_WINDOW sub-agents
    windowStart: number; // clamped + auto-followed start index into the sorted sub-agents
    canPrev: boolean;
    canNext: boolean;
  }
  export function windowSubAgents<T extends { id: string; sortOrder?: number | null }>(
    installed: T[], windowStart: number, activeId: string,
  ): AgentTabView<T>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/src/lib/agent-order.test.ts`:

```ts
import { windowSubAgents, AGENT_TAB_WINDOW } from "./agent-order.js";

describe("windowSubAgents", () => {
  const mk = (id: string, sortOrder: number | null = 0) => ({ id, sortOrder });
  const subs = [mk("a", 0), mk("b", 1), mk("c", 2), mk("d", 3)];

  it("pins general out and returns up to AGENT_TAB_WINDOW sub-agents", () => {
    const r = windowSubAgents([mk("general", 0), ...subs], 0, "general");
    expect(r.general?.id).toBe("general");
    expect(r.visible.map((a) => a.id)).toEqual(["a", "b"]);
    expect(AGENT_TAB_WINDOW).toBe(2);
  });

  it("reports canPrev/canNext at the window edges", () => {
    const start = windowSubAgents([mk("general"), ...subs], 0, "general");
    expect(start.canPrev).toBe(false);
    expect(start.canNext).toBe(true);
    const end = windowSubAgents([mk("general"), ...subs], 2, "general");
    expect(end.visible.map((a) => a.id)).toEqual(["c", "d"]);
    expect(end.canPrev).toBe(true);
    expect(end.canNext).toBe(false);
  });

  it("clamps an out-of-range windowStart", () => {
    const r = windowSubAgents([mk("general"), ...subs], 99, "general");
    expect(r.windowStart).toBe(2); // subs.length(4) - WINDOW(2)
    expect(r.visible.map((a) => a.id)).toEqual(["c", "d"]);
  });

  it("auto-follows an active sub-agent past the window end", () => {
    const r = windowSubAgents([mk("general"), ...subs], 0, "d");
    expect(r.visible.map((a) => a.id)).toEqual(["c", "d"]);
    expect(r.windowStart).toBe(2);
  });

  it("auto-follows an active sub-agent before the window start", () => {
    const r = windowSubAgents([mk("general"), ...subs], 2, "a");
    expect(r.visible.map((a) => a.id)).toEqual(["a", "b"]);
    expect(r.windowStart).toBe(0);
  });

  it("sorts sub-agents by sortOrder with nulls last", () => {
    const r = windowSubAgents([mk("general"), mk("x", null), mk("y", 5)], 0, "general");
    expect(r.visible.map((a) => a.id)).toEqual(["y", "x"]);
  });

  it("handles fewer sub-agents than the window", () => {
    const r = windowSubAgents([mk("general"), mk("a", 0)], 0, "general");
    expect(r.visible.map((a) => a.id)).toEqual(["a"]);
    expect(r.canPrev).toBe(false);
    expect(r.canNext).toBe(false);
    expect(r.windowStart).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @lot-agent/web -- agent-order`
Expected: FAIL — `windowSubAgents`/`AGENT_TAB_WINDOW` not exported.

- [ ] **Step 3: Implement the helper**

Add to `packages/web/src/lib/agent-order.ts` (keep existing `GENERAL_ID`, `splitInstalledAgents`, `MAX_VISIBLE_SUBAGENTS`):

```ts
export const AGENT_TAB_WINDOW = 2;

export interface AgentTabView<T> {
  general: T | null;
  visible: T[];
  windowStart: number;
  canPrev: boolean;
  canNext: boolean;
}

/** 传入已安装 agents:抽出 general,子 Agent 按 sortOrder 升序(null 最后),
 *  在子 Agent 上取一个宽度 AGENT_TAB_WINDOW 的滑动窗口。windowStart 会被夹取到
 *  合法区间,并自动跟随 activeId(激活的子 Agent 始终落在窗口内)。 */
export function windowSubAgents<T extends { id: string; sortOrder?: number | null }>(
  installed: T[],
  windowStart: number,
  activeId: string,
): AgentTabView<T> {
  const general = installed.find((a) => a.id === GENERAL_ID) ?? null;
  const rank = (a: T) => (a.sortOrder == null ? Number.POSITIVE_INFINITY : a.sortOrder);
  const subs = installed
    .filter((a) => a.id !== GENERAL_ID)
    .sort((a, b) => rank(a) - rank(b));

  const maxStart = Math.max(0, subs.length - AGENT_TAB_WINDOW);
  let start = Math.min(Math.max(windowStart, 0), maxStart);

  const activeIdx = subs.findIndex((a) => a.id === activeId);
  if (activeIdx >= 0) {
    if (activeIdx < start) start = activeIdx;
    else if (activeIdx >= start + AGENT_TAB_WINDOW) start = activeIdx - AGENT_TAB_WINDOW + 1;
    start = Math.min(Math.max(start, 0), maxStart);
  }

  return {
    general,
    visible: subs.slice(start, start + AGENT_TAB_WINDOW),
    windowStart: start,
    canPrev: start > 0,
    canNext: start + AGENT_TAB_WINDOW < subs.length,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @lot-agent/web -- agent-order`
Expected: PASS (both `splitInstalledAgents` and `windowSubAgents` suites).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/agent-order.ts packages/web/src/lib/agent-order.test.ts
git commit -m "feat(web): windowSubAgents sliding-window helper for sidebar tabs"
```

---

### Task 2: Extract shared agent icons

**Files:**
- Create: `packages/web/src/lib/agent-icons.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const AGENT_ICONS: Record<string, ReactNode>;
  export function agentIconKind(a: { type?: string; id: string }): string; // general|image|video|ppt|contract
  ```

- [ ] **Step 1: Create the module**

Create `packages/web/src/lib/agent-icons.tsx` — copy the `ICONS` map and `kindOf` verbatim from `AgentSwitcher.tsx` (lines 17–53), renamed to `AGENT_ICONS` / `agentIconKind`:

```tsx
import type { ReactNode } from "react";

/** Per-agent glyph for the tab icon badge. Keyed by agent type (id fallback). */
export const AGENT_ICONS: Record<string, ReactNode> = {
  general: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.6-.8L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
    </svg>
  ),
  image: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="8.5" cy="8.5" r="1.6" />
      <path d="m21 15-4.5-4.5L5 21" />
    </svg>
  ),
  video: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M10 9.5v5l4-2.5z" fill="currentColor" stroke="none" />
    </svg>
  ),
  ppt: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  contract: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
      <path d="M14 2v6h6M9 13l2 2 4-4" />
    </svg>
  ),
};

export function agentIconKind(a: { type?: string; id: string }): string {
  const key = a.type || a.id;
  return key in AGENT_ICONS ? key : "general";
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run build -w @lot-agent/web`
Expected: PASS (new module compiles; `AgentSwitcher.tsx` still has its own copy and is untouched).

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/agent-icons.tsx
git commit -m "feat(web): extract shared agent icon map (agent-icons)"
```

---

### Task 3: SidebarAgentTabs component + styles

**Files:**
- Create: `packages/web/src/components/SidebarAgentTabs.tsx`
- Modify: `packages/web/src/App.css` (add `.sidebar-agent-tabs` block; no removals yet)

**Interfaces:**
- Consumes: `windowSubAgents`, `AGENT_ICONS`, `agentIconKind`, `Agent`.
- Produces:
  ```ts
  interface SidebarAgentTabsProps {
    agents: Agent[];        // installed agents (incl. general)
    activeId: string;
    onSwitch: (agentId: string) => void;
    disabled?: boolean;
  }
  export function SidebarAgentTabs(props: SidebarAgentTabsProps): JSX.Element;
  ```

- [ ] **Step 1: Create the component**

Create `packages/web/src/components/SidebarAgentTabs.tsx`:

```tsx
import { useState } from "react";
import type { Agent } from "../api/client.js";
import { windowSubAgents } from "../lib/agent-order.js";
import { AGENT_ICONS, agentIconKind } from "../lib/agent-icons.js";

interface SidebarAgentTabsProps {
  /** 已安装 agents(含 general);组件内部负责排序/窗口。 */
  agents: Agent[];
  activeId: string;
  onSwitch: (agentId: string) => void;
  disabled?: boolean;
}

export function SidebarAgentTabs({ agents, activeId, onSwitch, disabled }: SidebarAgentTabsProps) {
  const [windowStart, setWindowStart] = useState(0);
  const { general, visible, windowStart: start, canPrev, canNext } = windowSubAgents(
    agents,
    windowStart,
    activeId,
  );

  const renderTab = (a: Agent) => {
    const kind = agentIconKind(a);
    return (
      <button
        key={a.id}
        type="button"
        className={`agent-tab ${a.id === activeId ? "active" : ""}`}
        onClick={() => onSwitch(a.id)}
        disabled={disabled}
        title={a.description}
      >
        <span className={`agent-tab-icon agent-tab-icon--${kind}`} aria-hidden>
          {AGENT_ICONS[kind]}
        </span>
        <span className="agent-tab-label">{a.name}</span>
      </button>
    );
  };

  const hasArrows = canPrev || canNext;

  return (
    <div className="sidebar-agent-tabs">
      {general && renderTab(general)}
      {hasArrows && (
        <button
          type="button"
          className="agent-tab-arrow"
          onClick={() => setWindowStart(start - 1)}
          disabled={disabled || !canPrev}
          title="上一组"
          aria-label="上一组"
        >
          ‹
        </button>
      )}
      {visible.map(renderTab)}
      {hasArrows && (
        <button
          type="button"
          className="agent-tab-arrow"
          onClick={() => setWindowStart(start + 1)}
          disabled={disabled || !canNext}
          title="下一组"
          aria-label="下一组"
        >
          ›
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add styles**

In `packages/web/src/App.css`, add a new block (place it right after the `.sidebar-recent-header` rules, ~line 1566). All tokens already exist in `:root`/`[data-theme="dark"]`:

```css
/* ── Sidebar agent tabs (通用 pinned + windowed sub-agents + < > arrows) ── */
.sidebar-agent-tabs {
  display: flex;
  align-items: stretch;
  gap: 6px;
  padding: 4px 12px 10px;
}

.agent-tab {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  border-radius: 14px;
  background: var(--bg-card);
  border: 1.5px solid var(--border);
  box-shadow: var(--neu-raise-sm);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.14s, transform 0.14s;
}

.agent-tab:hover:not(:disabled) {
  border-color: var(--border-input);
  transform: translateY(-2px);
  box-shadow: var(--neu-raise);
}
.agent-tab:active:not(:disabled) { transform: translateY(0) scale(0.97); }

.agent-tab.active {
  border-color: transparent;
  background:
    linear-gradient(var(--bg-card), var(--bg-card)) padding-box,
    var(--accent-grad) border-box;
  box-shadow: var(--neu-pop);
}
.agent-tab:disabled { opacity: 0.55; cursor: default; }

.agent-tab-icon {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--icon-on-grad);
  flex-shrink: 0;
}
.agent-tab-icon svg { width: 15px; height: 15px; }
.agent-tab-icon--general  { background: var(--agent-icon-general); }
.agent-tab-icon--image    { background: var(--agent-icon-image); }
.agent-tab-icon--video    { background: var(--agent-icon-video); }
.agent-tab-icon--ppt      { background: var(--agent-icon-general); }
.agent-tab-icon--contract { background: var(--agent-icon-general); }

.agent-tab-label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1;
}

.agent-tab-arrow {
  flex: 0 0 auto;
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  background: var(--bg-card);
  border: 1.5px solid var(--border);
  border-radius: 10px;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}
.agent-tab-arrow:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.agent-tab-arrow:disabled { opacity: 0.4; cursor: default; }
```

- [ ] **Step 3: Verify it type-checks**

Run: `npm run build -w @lot-agent/web`
Expected: PASS (component compiles; not yet rendered anywhere).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/SidebarAgentTabs.tsx packages/web/src/App.css
git commit -m "feat(web): SidebarAgentTabs component + styles"
```

---

### Task 4: Wire tabs into the sidebar; remove old tag + AgentSwitcher

**Files:**
- Modify: `packages/web/src/components/Sidebar.tsx`
- Modify: `packages/web/src/pages/Workspace.tsx`
- Modify: `packages/web/src/components/ChatPanel.tsx`
- Modify: `packages/web/src/lib/agent-order.ts` (remove `splitInstalledAgents` + `MAX_VISIBLE_SUBAGENTS`)
- Modify: `packages/web/src/lib/agent-order.test.ts` (remove the `splitInstalledAgents` suite)
- Modify: `packages/web/src/App.css` (remove obsolete selectors)
- Delete: `packages/web/src/components/AgentSwitcher.tsx`
- Delete: `packages/web/src/components/AgentOverflowPopover.tsx`

**Interfaces:**
- Consumes: `SidebarAgentTabs` (Task 3), `windowSubAgents` (Task 1).
- Produces: new `Sidebar` props `installedAgents: Agent[]`, `activeAgentId: string`, `onSwitchAgent: (id: string) => void`, `switchDisabled?: boolean` (replacing the old `agents` prop).

- [ ] **Step 1: Rewrite `Sidebar.tsx`**

Replace the entire file with:

```tsx
import { useCallback } from "react";
import type { Agent, Conversation } from "../api/client.js";
import { SidebarAgentTabs } from "./SidebarAgentTabs.js";

interface SidebarProps {
  conversations: Conversation[];
  installedAgents: Agent[];
  activeAgentId: string;
  onSwitchAgent: (agentId: string) => void;
  switchDisabled?: boolean;
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}

/** Trigger loadMore when the scroll position is within this many px of bottom. */
const LOAD_MORE_THRESHOLD = 80;

export function Sidebar({
  conversations,
  installedAgents,
  activeAgentId,
  onSwitchAgent,
  switchDisabled,
  activeId,
  onSelect,
  onDelete,
  onCreate,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
}: SidebarProps) {
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!onLoadMore || !hasMore || loadingMore) return;
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= LOAD_MORE_THRESHOLD) {
        onLoadMore();
      }
    },
    [onLoadMore, hasMore, loadingMore]
  );

  return (
    <aside className="sidebar">
      <SidebarAgentTabs
        agents={installedAgents}
        activeId={activeAgentId}
        onSwitch={onSwitchAgent}
        disabled={switchDisabled}
      />
      <div className="sidebar-recent-header">
        {conversations.length > 0 && <span className="sidebar-section-label">历史对话</span>}
        <button className="btn-new" onClick={onCreate} title="新建对话">
          <svg className="btn-new-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 8.5v7M8.5 12h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          新对话
        </button>
      </div>
      <div className="sidebar-list" onScroll={handleScroll}>
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`sidebar-item ${conv.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(conv.id)}
          >
            <span className="sidebar-item-title">{conv.title}</span>
            <button
              className="btn-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(conv.id);
              }}
            >
              x
            </button>
          </div>
        ))}
        {loadingMore && <div className="sidebar-loading-more">加载中…</div>}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Update `Workspace.tsx` — filter list, wire Sidebar, drop AgentSwitcher**

In `packages/web/src/pages/Workspace.tsx`:

Remove the import line:
```tsx
import { AgentSwitcher } from "../components/AgentSwitcher.js";
```

Replace the `sidebarConversations` memo (currently lines ~215-221) with an agent-filtered version:
```tsx
  // Sidebar list: filtered to the active agent; prepend a virtual "新对话" entry
  // when in new-chat mode (its agent_id equals activeAgentId, so it passes the filter).
  const sidebarConversations = useMemo(() => {
    const filtered = conversations.filter((c) => c.agent_id === activeAgentId);
    if (!newAgentId) return filtered;
    return [
      { id: "__new__", title: "新对话", agent_id: newAgentId, created_at: "", updated_at: "" },
      ...filtered,
    ];
  }, [newAgentId, conversations, activeAgentId]);
```

Remove the `switcher` element (currently lines ~223-231):
```tsx
  const switcher = (
    <AgentSwitcher ... />
  );
```

Update the `<Sidebar .../>` usage — replace the `agents={agents}` prop with the tab-bar props:
```tsx
        <Sidebar
          conversations={sidebarConversations}
          installedAgents={installed}
          activeAgentId={activeAgentId}
          onSwitchAgent={handleSwitchAgent}
          switchDisabled={isStreaming}
          activeId={newAgentId ? "__new__" : activeId}
          onSelect={handleSelect}
          onDelete={handleDelete}
          onCreate={handleCreate}
          onLoadMore={loadMore}
          hasMore={hasMore}
          loadingMore={loadingMore}
        />
```

In the `<ChatPanel .../>` usage, remove the `inputAbove={switcher}` line.

- [ ] **Step 3: Update `ChatPanel.tsx` — drop `inputAbove`**

In `packages/web/src/components/ChatPanel.tsx`:

Remove from the `ChatPanelProps` interface:
```tsx
  /** Content rendered directly above the input box (agent switcher). */
  inputAbove?: React.ReactNode;
```
Remove `inputAbove,` from the destructured props.
Remove the wrapper line inside `inputEl`:
```tsx
      {inputAbove && <div className="input-switcher">{inputAbove}</div>}
```

- [ ] **Step 4: Remove `splitInstalledAgents` from `agent-order.ts` and its test suite**

In `packages/web/src/lib/agent-order.ts`, delete `MAX_VISIBLE_SUBAGENTS`, the `SplitAgents` interface, and the `splitInstalledAgents` function. Keep `GENERAL_ID`, `AGENT_TAB_WINDOW`, `AgentTabView`, and `windowSubAgents`.

In `packages/web/src/lib/agent-order.test.ts`, delete the `describe("splitInstalledAgents", …)` block and its `import { splitInstalledAgents, MAX_VISIBLE_SUBAGENTS } from "./agent-order.js";` line. Keep the `windowSubAgents` suite from Task 1.

- [ ] **Step 5: Delete obsolete components**

```bash
git rm packages/web/src/components/AgentSwitcher.tsx packages/web/src/components/AgentOverflowPopover.tsx
```

- [ ] **Step 6: Remove obsolete CSS**

In `packages/web/src/App.css`, delete these rule blocks (now unused):
- `.agent-tag` and `.agent-tag--general/--copy/--image/--video` (~lines 252-267)
- `.input-switcher` (~line 2013)
- `.agent-switcher` (~line 2018)
- `.agent-pill`, `.agent-pill:hover…`, `.agent-pill:active…`, `.agent-pill.active`, `.agent-pill:disabled`, `.agent-pill-icon`, `.agent-pill-icon svg`, `.agent-pill-icon--general/--image/--video`, `.agent-pill-label` (~lines 2024-2089)
- `.agent-more-wrap`, `.agent-more`, and any `.agent-overflow*` rules (~lines 2337-2408)

Leave the `--agent-icon-*` and `--tag-*` CSS variables in `:root`/`[data-theme]` in place (harmless; `--agent-icon-*` are reused by the new tabs).

- [ ] **Step 7: Verify build + tests pass**

Run: `npm run build -w @lot-agent/web && npm test -w @lot-agent/web`
Expected: PASS — no references to `AgentSwitcher`, `AgentOverflowPopover`, `splitInstalledAgents`, `inputAbove`, or `MAX_VISIBLE_SUBAGENTS` remain. Confirm with:
```bash
grep -rn "AgentSwitcher\|AgentOverflowPopover\|splitInstalledAgents\|inputAbove\|MAX_VISIBLE_SUBAGENTS\|agent-tag\|input-switcher\|agent-pill" packages/web/src
```
Expected: no matches.

- [ ] **Step 8: Manual verification**

Run: `npm run dev:web` (with the server running). Verify:
- Sidebar shows `通用` first + up to 2 sub-agent tabs; `< >` arrows appear only with >2 installed sub-agents and page the window.
- Clicking a tab filters the list to that agent's conversations AND switches the active agent (empty-state hero updates); the `新对话` entry appears under the selected tab.
- Selecting an existing conversation highlights the matching tab (auto-follow into view if paged away).
- Tabs are disabled while a response is streaming.
- No per-conversation tag remains; no switcher above the input.
- Toggle dark/light theme — tabs render correctly in both.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(web): sidebar agent tabs replace per-conv tag + AgentSwitcher

Tabs filter the conversation list to the active agent and switch it;
通用 pinned first, 2 sub-agent tabs windowed with < > paging. Removes the
per-conversation agent tag, the above-input AgentSwitcher/overflow popover,
and splitInstalledAgents. Header renamed 最近对话→历史对话, 新会话→新对话."
```

---

## Self-Review

**Spec coverage:**
- Tab bar, 通用 pinned + default → Task 3/4 (render order; default because `activeAgentId` starts at `defaultAgentId` = general in `Workspace`).
- Only 2 sub-tabs + `< >` paging, auto-follow → Task 1 (`windowSubAgents`), Task 3 (arrows).
- Tabs only for installed agents → Task 4 passes `installed`.
- Tab click filters + switches → Task 4 (`sidebarConversations` filter + `onSwitchAgent={handleSwitchAgent}`).
- Remove per-conv tag → Task 4 Step 1 & 6.
- Remove AgentSwitcher above input → Task 4 Steps 2, 3, 5, 6.
- Header rename → Task 4 Step 1.
- Client-side filtering (known limitation) → Task 4 Step 2 memo.
- Unit test for paging helper → Task 1.

**Placeholder scan:** none — all steps carry concrete code/commands.

**Type consistency:** `windowSubAgents(installed, windowStart, activeId)` and `AgentTabView` fields (`general/visible/windowStart/canPrev/canNext`) used identically in Tasks 1 & 3. `SidebarAgentTabs` prop names (`agents/activeId/onSwitch/disabled`) match between Tasks 3 & 4. New `Sidebar` props (`installedAgents/activeAgentId/onSwitchAgent/switchDisabled`) match between the rewrite (Task 4 Step 1) and the Workspace usage (Task 4 Step 2). `agentIconKind`/`AGENT_ICONS` match between Tasks 2 & 3.

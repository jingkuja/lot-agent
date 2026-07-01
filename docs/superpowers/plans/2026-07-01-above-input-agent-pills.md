# Above-input Agent Pills + Non-destructive Tab Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the above-input agent pill row (max 6 + 更多 popup) alongside the existing sidebar tabs, and make switching an agent tab non-destructive to the open conversation.

**Architecture:** Re-add the three pieces commit `6caaf5b` deleted (`splitInstalledAgents` helper, `AgentOverflowPopover`, `AgentSwitcher`) reusing the shared `lib/agent-icons.tsx`. `ChatPanel` regains an `inputAbove` slot that renders the switcher above the input in both the empty hero and an active conversation. In `Workspace`, `activeAgentId` becomes highlight/filter-only; a derived `openAgentId` drives the chat panel, so switching a tab no longer clears the chat, and `新对话` starts on the open chat's agent.

**Tech Stack:** React 19, TypeScript (ESM, `.js` import suffixes), Vitest, Vite, CSS variables for theming.

## Global Constraints

- ESM imports use explicit `.js` suffixes (e.g. `from "./agent-order.js"`); 2-space indent.
- Web theming: use existing `var(--*)` tokens only — never hardcode hex/`rgba`, or light mode breaks.
- Tests use Vitest, colocated as `*.test.ts`.
- Typecheck/build a web change with: `npm run build -w @lot-agent/web`.
- `general` agent is pinned first; sub-agents sort by `sortOrder` ascending with `null` last.
- Keep the existing sidebar `SidebarAgentTabs` / `windowSubAgents` untouched (both switchers coexist).

---

### Task 1: Restore `splitInstalledAgents` helper (max 6 + overflow)

**Files:**
- Modify: `packages/web/src/lib/agent-order.ts`
- Test: `packages/web/src/lib/agent-order.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export const MAX_VISIBLE_SUBAGENTS = 6;`
  - `export interface SplitAgents<T> { general: T | null; visible: T[]; overflow: T[]; }`
  - `export function splitInstalledAgents<T extends { id: string; sortOrder?: number | null }>(installed: T[]): SplitAgents<T>`

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/src/lib/agent-order.test.ts`. Also add `splitInstalledAgents, MAX_VISIBLE_SUBAGENTS` to the existing import on line 2 so it reads:

```typescript
import { windowSubAgents, AGENT_TAB_WINDOW, splitInstalledAgents, MAX_VISIBLE_SUBAGENTS } from "./agent-order.js";
```

Then append this describe block at the end of the file:

```typescript
describe("splitInstalledAgents", () => {
  it("extracts general and keeps the first MAX_VISIBLE_SUBAGENTS visible", () => {
    const subs = Array.from({ length: 8 }, (_, i) => mk(`s${i}`, i));
    const r = splitInstalledAgents([mk("general", 0), ...subs]);
    expect(r.general?.id).toBe("general");
    expect(MAX_VISIBLE_SUBAGENTS).toBe(6);
    expect(r.visible.map((a) => a.id)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
    expect(r.overflow.map((a) => a.id)).toEqual(["s6", "s7"]);
  });

  it("sorts sub-agents by sortOrder with nulls last", () => {
    const r = splitInstalledAgents([mk("general"), mk("x", null), mk("y", 5), mk("z", 1)]);
    expect(r.visible.map((a) => a.id)).toEqual(["z", "y", "x"]);
    expect(r.overflow).toEqual([]);
  });

  it("returns null general and empty overflow when absent", () => {
    const r = splitInstalledAgents([mk("a", 0), mk("b", 1)]);
    expect(r.general).toBeNull();
    expect(r.visible.map((a) => a.id)).toEqual(["a", "b"]);
    expect(r.overflow).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @lot-agent/web -- agent-order`
Expected: FAIL — `splitInstalledAgents is not a function` / `MAX_VISIBLE_SUBAGENTS` undefined.

- [ ] **Step 3: Implement the helper**

In `packages/web/src/lib/agent-order.ts`, add directly below the existing `AGENT_TAB_WINDOW = 2;` line (keep everything else in the file unchanged):

```typescript
export const MAX_VISIBLE_SUBAGENTS = 6;

export interface SplitAgents<T> {
  general: T | null;
  visible: T[];
  overflow: T[];
}

/** 传入已安装 agents:抽出 general,子 Agent 按 sortOrder 升序(null 最后),
 *  前 MAX_VISIBLE_SUBAGENTS 个可见,其余进溢出。 */
export function splitInstalledAgents<T extends { id: string; sortOrder?: number | null }>(
  installed: T[]
): SplitAgents<T> {
  const general = installed.find((a) => a.id === GENERAL_ID) ?? null;
  const rank = (a: T) => (a.sortOrder == null ? Number.POSITIVE_INFINITY : a.sortOrder);
  const subs = installed
    .filter((a) => a.id !== GENERAL_ID)
    .sort((a, b) => rank(a) - rank(b));
  return {
    general,
    visible: subs.slice(0, MAX_VISIBLE_SUBAGENTS),
    overflow: subs.slice(MAX_VISIBLE_SUBAGENTS),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @lot-agent/web -- agent-order`
Expected: PASS (existing `windowSubAgents` tests + 3 new `splitInstalledAgents` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/agent-order.ts packages/web/src/lib/agent-order.test.ts
git commit -m "feat(web): restore splitInstalledAgents helper (max 6 + overflow)"
```

---

### Task 2: Restore `AgentOverflowPopover` + `AgentSwitcher` components + CSS

**Files:**
- Create: `packages/web/src/components/AgentOverflowPopover.tsx`
- Create: `packages/web/src/components/AgentSwitcher.tsx`
- Modify: `packages/web/src/App.css` (append the pill/popover styles)

**Interfaces:**
- Consumes: `splitInstalledAgents` (Task 1); `AGENT_ICONS`, `agentIconKind` from `lib/agent-icons.tsx`; `Agent` from `api/client.ts`.
- Produces:
  - `AgentOverflowPopover` props: `{ agents: Agent[]; activeId: string; onPick: (id: string) => void; onClose: () => void }`
  - `AgentSwitcher` props: `{ agents: Agent[]; activeId: string; onSwitch: (agentId: string) => void; onPickOverflow: (agentId: string) => void; disabled?: boolean }`

- [ ] **Step 1: Create `AgentOverflowPopover.tsx`**

```tsx
import { useEffect, useRef } from "react";
import type { Agent } from "../api/client.js";

interface Props {
  agents: Agent[];
  activeId: string;
  onPick: (id: string) => void;
  onClose: () => void;
}

/** 「更多」轻量浮层:列出未显示的已安装 Agent,点选即快速切换。 */
export function AgentOverflowPopover({ agents, activeId, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  return (
    <div className="agent-overflow-popover" ref={ref} role="menu">
      {agents.map((a) => (
        <button
          key={a.id}
          type="button"
          role="menuitem"
          className={`agent-overflow-item ${a.id === activeId ? "active" : ""}`}
          onClick={() => onPick(a.id)}
        >
          {a.name}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create `AgentSwitcher.tsx`**

Note: unlike the pre-`6caaf5b` version, this uses the shared `agent-icons.tsx` instead of a local `ICONS` map.

```tsx
import { useState } from "react";
import type { Agent } from "../api/client.js";
import { splitInstalledAgents } from "../lib/agent-order.js";
import { AGENT_ICONS, agentIconKind } from "../lib/agent-icons.js";
import { AgentOverflowPopover } from "./AgentOverflowPopover.js";

interface AgentSwitcherProps {
  /** 已安装 agents(含 general);组件内部负责排序/截断。 */
  agents: Agent[];
  activeId: string;
  onSwitch: (agentId: string) => void;
  onPickOverflow: (agentId: string) => void;
  disabled?: boolean;
}

export function AgentSwitcher({ agents, activeId, onSwitch, onPickOverflow, disabled }: AgentSwitcherProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const { general, visible, overflow } = splitInstalledAgents(agents);
  const pills = general ? [general, ...visible] : visible;

  const renderPill = (a: Agent) => {
    const kind = agentIconKind(a);
    return (
      <button
        key={a.id}
        type="button"
        className={`agent-pill ${a.id === activeId ? "active" : ""}`}
        onClick={() => onSwitch(a.id)}
        disabled={disabled}
        title={a.description}
      >
        <span className={`agent-pill-icon agent-pill-icon--${kind}`} aria-hidden>
          {AGENT_ICONS[kind]}
        </span>
        <span className="agent-pill-label">{a.name}</span>
      </button>
    );
  };

  return (
    <div className="agent-switcher">
      {pills.map(renderPill)}
      {overflow.length > 0 && (
        <div className="agent-more-wrap">
          <button
            type="button"
            className="agent-pill agent-more"
            onClick={() => setOverflowOpen((v) => !v)}
            disabled={disabled}
            title="更多已安装 Agent"
          >
            <span className="agent-pill-label">更多</span>
          </button>
          {overflowOpen && (
            <AgentOverflowPopover
              agents={overflow}
              activeId={activeId}
              onPick={(id) => { setOverflowOpen(false); onPickOverflow(id); }}
              onClose={() => setOverflowOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Append the CSS block to `App.css`**

Append at the end of `packages/web/src/App.css`. All values use existing `var(--*)` tokens (`--agent-icon-general/image/video` are already defined for the sidebar tabs):

```css
/* ── Agent Switcher (above input) ── */
/* Card pills with colored icon badges, rendered above the input box
   (.input-switcher wraps it for spacing). */
.input-switcher {
  display: flex;
  margin-bottom: 12px;
}

.agent-switcher {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.agent-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: var(--bg-card);
  border: 1.5px solid var(--border);
  border-radius: 999px;
  color: var(--text);
  padding: 5px 13px 5px 6px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  white-space: nowrap;
  box-shadow: var(--neu-raise-sm);
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.14s, transform 0.14s;
}

.agent-pill:hover:not(:disabled) {
  border-color: var(--border-input);
  transform: translateY(-2px);
  box-shadow: var(--neu-raise);
}

.agent-pill:active:not(:disabled) {
  transform: translateY(0) scale(0.97);
}

/* Active pill: violet→blue gradient border (same double-background trick as the
   input box) so the card face stays solid. */
.agent-pill.active {
  border-color: transparent;
  background:
    linear-gradient(var(--bg-card), var(--bg-card)) padding-box,
    var(--accent-grad) border-box;
  box-shadow: var(--neu-pop);
}

.agent-pill:disabled {
  opacity: 0.55;
  cursor: default;
}

.agent-pill-icon {
  width: 23px;
  height: 23px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--icon-on-grad);
  flex-shrink: 0;
}

.agent-pill-icon svg {
  width: 14px;
  height: 14px;
}

.agent-pill-icon--general { background: var(--agent-icon-general); }
.agent-pill-icon--image   { background: var(--agent-icon-image); }
.agent-pill-icon--video   { background: var(--agent-icon-video); }

.agent-pill-label {
  line-height: 1;
}

.agent-more-wrap { position: relative; display: inline-flex; }
.agent-overflow-popover {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 160px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 4px;
  box-shadow: var(--shadow-lg);
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.agent-overflow-item {
  text-align: left;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 14px;
}
.agent-overflow-item:hover { background: var(--bg-hover); }
.agent-overflow-item.active { color: var(--accent); font-weight: 600; }
```

- [ ] **Step 4: Typecheck**

Run: `npm run build -w @lot-agent/web`
Expected: builds with no TS errors. (The components compile even though nothing renders them yet.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/AgentSwitcher.tsx packages/web/src/components/AgentOverflowPopover.tsx packages/web/src/App.css
git commit -m "feat(web): restore AgentSwitcher + AgentOverflowPopover + pill styles"
```

---

### Task 3: Wire the switcher into ChatPanel + Workspace with non-destructive switching

**Files:**
- Modify: `packages/web/src/components/ChatPanel.tsx`
- Modify: `packages/web/src/pages/Workspace.tsx`

**Interfaces:**
- Consumes: `AgentSwitcher` (Task 2), `splitInstalledAgents` indirectly, existing `useAgents().promote`, `api.createConversation`.
- Produces: `ChatPanel` gains prop `inputAbove?: React.ReactNode`. No new exported symbols from Workspace.

- [ ] **Step 1: Add the `inputAbove` slot to ChatPanel**

In `packages/web/src/components/ChatPanel.tsx`:

(a) Add the prop to `ChatPanelProps` (after the `agent?: Agent | null;` block, around line 19):

```tsx
  /** Content rendered directly above the input box (agent switcher). */
  inputAbove?: React.ReactNode;
```

(b) Add `inputAbove` to the destructured params (in the function signature list, e.g. after `agent,`):

```tsx
  agent,
  inputAbove,
```

(c) Render it inside the shared `inputEl`, directly above `<InputBox ...>`. Change the `inputEl` definition so it reads:

```tsx
  const inputEl = (
    <>
      {inputAbove && <div className="input-switcher">{inputAbove}</div>}
      <InputBox
        onSend={onSend}
        onStop={onStop}
        disabled={isStreaming}
        autoFocus={isEmpty}
        mode={mode}
        placeholder={mode !== "default" ? "请输入内容" : undefined}
        models={modelList ?? []}
        selectedModel={selectedModel ?? null}
        onModelChange={onModelChange}
      />
    </>
  );
```

- [ ] **Step 2: Derive `openAgentId` / `openAgent` in Workspace**

In `packages/web/src/pages/Workspace.tsx`:

(a) Add the `AgentSwitcher` import near the other component imports (top of file):

```tsx
import { AgentSwitcher } from "../components/AgentSwitcher.js";
```

(b) Add a derived `openAgentId` + `openAgent`. The open chat's agent is the pending new-chat agent, else the loaded conversation's agent, else the default:

```tsx
  // The agent of the chat currently on screen (drives the panel/input/model),
  // decoupled from activeAgentId which only highlights the tab + filters the list.
  const openAgentId =
    newAgentId ??
    conversations.find((c) => c.id === activeId)?.agent_id ??
    defaultAgentId;
  const openAgent = agents.find((a) => a.id === openAgentId) ?? null;
```

Placement: this reads `newAgentId`, `conversations`, and `activeId`, so it must go **after** the `useConversations()` destructure block (which declares `conversations`/`activeId`, currently ending line 49). Insert it immediately after that block. Leave the existing `activeAgent` declaration (line 32) untouched.

- [ ] **Step 3: Make `handleSwitchAgent` non-destructive**

Replace the whole `handleSwitchAgent` callback (currently lines 92-109) with:

```tsx
  const handleSwitchAgent = useCallback(
    (agentId: string) => {
      if (newAgentId) {
        // Empty/new-chat hero: nothing committed — retarget the pending chat.
        setNewAgentId(agentId);
        setActiveAgentId(agentId);
        return;
      }
      // A real conversation is open: only re-highlight + filter the sidebar.
      // Do NOT touch activeId / messages / preview — the chat stays on screen.
      setActiveAgentId(agentId);
    },
    [newAgentId]
  );
```

- [ ] **Step 4: Make `新对话` (`handleCreate`) start on the open chat's agent**

Replace `handleCreate` (currently lines 126-132) with:

```tsx
  const handleCreate = useCallback(() => {
    if (newAgentId) return; // already in new-chat mode
    // New chat uses the open conversation's agent (not the highlighted tab);
    // highlight + filter follow it.
    setNewAgentId(openAgentId);
    setActiveAgentId(openAgentId);
    setActiveId(null);
    clear();
    setPreviewContent(null);
  }, [newAgentId, openAgentId, setActiveId, clear]);
```

- [ ] **Step 5: Restore `handlePickOverflow`**

Add this callback right after `handleSwitchAgent`. It promotes the picked agent (so it enters the visible 6) then switches to it:

```tsx
  const handlePickOverflow = useCallback(
    async (agentId: string) => {
      await promote(agentId); // 移到子 Agent 首位,持久化 sortOrder
      handleSwitchAgent(agentId);
    },
    [promote, handleSwitchAgent]
  );
```

Also add `promote` to the `useAgents(true)` destructure at the top of the component:

```tsx
  const { agents, installed, install, uninstall, promote } = useAgents(true);
```

- [ ] **Step 6: Point `doSend` / preview / ChatPanel at `openAgent`**

Three edits in the render/handlers so the panel follows the open chat, not the highlighted tab:

(a) In `doSend` (currently line 137) change `activeAgent` → `openAgent`:

```tsx
      const kind = openAgent?.type || openAgent?.id;
```
and update that callback's dependency array: replace `activeAgent` with `openAgent`.

(b) In the `<ChatPanel .../>` render, change the `agent` prop and the preview guard, and add the `inputAbove` prop:

```tsx
            onSelectForPreview={
              openAgent?.type === "copywriting" || openAgent?.id === "copywriting"
                ? setPreviewContent
                : undefined
            }
            agent={openAgent}
            inputAbove={
              <AgentSwitcher
                agents={installed}
                activeId={activeAgentId}
                onSwitch={handleSwitchAgent}
                onPickOverflow={handlePickOverflow}
                disabled={isStreaming}
              />
            }
```

Leave `activeAgentId` driving the `Sidebar` props (highlight + filter) exactly as they are.

- [ ] **Step 7: Typecheck the build**

Run: `npm run build -w @lot-agent/web`
Expected: builds with no TS errors.

- [ ] **Step 8: Manual verification**

Run: `npm run dev:web` (with the server running) and check in the browser:
- Pills appear above the input in the empty hero AND during a conversation; `通用助手` pinned first.
- With >6 sub-agents installed, only 6 show + a `更多` pill; the popover lists the rest and promotes one to the visible row on pick.
- Open a conversation, then click a different agent's pill → the chat on screen does NOT change; the sidebar list re-filters and the pill/sidebar highlight moves.
- With that conversation still open, click `新对话` → a fresh chat opens on the conversation's own agent (hero title matches), not the previously highlighted tab.
- Selecting a conversation from the sidebar still syncs the active tab to that conversation's agent.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/components/ChatPanel.tsx packages/web/src/pages/Workspace.tsx
git commit -m "feat(web): render agent pills above input; non-destructive tab switching"
```

---

## Self-Review Notes

- **Spec coverage:** Req 1 (restore pills, max 6 + 更多, shared icons, sidebar tabs kept) → Tasks 1–2 + Task 3 Step 6. Req 2 (openAgentId decoupling, non-destructive switch, 新对话 on open agent, 更多 promote) → Task 3 Steps 2–6. CSS restore → Task 2 Step 3.
- **Type consistency:** `splitInstalledAgents` / `SplitAgents` / `MAX_VISIBLE_SUBAGENTS` names match across Tasks 1–2. `AgentSwitcher` props (`onSwitch`, `onPickOverflow`) match the Workspace wiring in Task 3 Step 6. `inputAbove` prop name consistent between ChatPanel (Task 3 Step 1) and Workspace (Step 6).
- **Accepted edge case (from spec):** after switching a tab with a real conversation open, the open conversation may fall outside the `activeAgentId`-filtered sidebar list, so no sidebar row highlights — intended.

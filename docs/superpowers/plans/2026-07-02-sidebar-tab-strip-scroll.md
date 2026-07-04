# Sidebar Tab Strip Native Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `SidebarAgentTabs`' 2-wide windowed paging (whose active-follow clamp makes the `›` arrow dead) with a native horizontally scrollable tab strip.

**Architecture:** Sub-agent tabs move into an `overflow-x: auto` strip (hidden scrollbar, edge fade). The `‹`/`›` arrows become smooth `scrollBy` nudges shown only on real overflow; active-tab following happens only when `activeId` changes (`scrollIntoView`), so it never fights manual scrolling. The shared "sort sub-agents by sortOrder, null last" logic is extracted to `sortedSubAgents`; `windowSubAgents` is deleted.

**Tech Stack:** React 19, Vitest, plain CSS (`packages/web/src/App.css` design tokens).

Spec: `docs/superpowers/specs/2026-07-02-sidebar-tab-strip-scroll-design.md`

## Global Constraints

- ESM imports use explicit `.js` suffixes; 2-space indent.
- CSS colors must use existing `var(--*)` tokens — no hardcoded hex/rgba. (Exception noted in Task 2: `mask-image` gradient stops are alpha-only, not rendered colors.)
- No changes to `Sidebar.tsx` (the `SidebarAgentTabs` props contract is unchanged), the above-input pill row, `splitInstalledAgents` behavior, or any server code.
- All commands below run from the repo root `/Users/nikin/project/practice/lot-agent`.

---

### Task 1: Extract `sortedSubAgents` in `agent-order.ts`

**Files:**
- Modify: `packages/web/src/lib/agent-order.ts`
- Test: `packages/web/src/lib/agent-order.test.ts`

**Interfaces:**
- Produces: `sortedSubAgents<T extends { id: string; sortOrder?: number | null }>(installed: T[]): T[]` — filters out `general`, sorts by `sortOrder` ascending with `null`/`undefined` last. Task 2 imports it. `splitInstalledAgents` keeps its exact signature and behavior.

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/src/lib/agent-order.test.ts`: import `sortedSubAgents` on line 2 and append this describe block at the end of the file:

```ts
import { windowSubAgents, AGENT_TAB_WINDOW, splitInstalledAgents, MAX_VISIBLE_SUBAGENTS, sortedSubAgents } from "./agent-order.js";
```

```ts
describe("sortedSubAgents", () => {
  it("excludes general and sorts by sortOrder ascending", () => {
    const r = sortedSubAgents([mk("general", 0), mk("b", 2), mk("a", 1)]);
    expect(r.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("puts null sortOrder last", () => {
    const r = sortedSubAgents([mk("x", null), mk("y", 5)]);
    expect(r.map((a) => a.id)).toEqual(["y", "x"]);
  });

  it("returns empty for general-only input", () => {
    expect(sortedSubAgents([mk("general", 0)])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/src/lib/agent-order.test.ts`
Expected: FAIL — `sortedSubAgents` is not exported (`SyntaxError` / `TypeError: sortedSubAgents is not a function`).

- [ ] **Step 3: Implement `sortedSubAgents` and refactor the two callers**

In `packages/web/src/lib/agent-order.ts`, add above `windowSubAgents`:

```ts
/** 子 Agent(排除 general)按 sortOrder 升序,null 最后。 */
export function sortedSubAgents<T extends { id: string; sortOrder?: number | null }>(
  installed: T[]
): T[] {
  const rank = (a: T) => (a.sortOrder == null ? Number.POSITIVE_INFINITY : a.sortOrder);
  return installed
    .filter((a) => a.id !== GENERAL_ID)
    .sort((a, b) => rank(a) - rank(b));
}
```

Then replace the duplicated `rank`/`filter`/`sort` blocks in both `windowSubAgents` and `splitInstalledAgents` with `const subs = sortedSubAgents(installed);` (delete each function's local `rank` const and the `installed.filter(...).sort(...)` expression; everything else stays).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/src/lib/agent-order.test.ts`
Expected: PASS — all existing `windowSubAgents` / `splitInstalledAgents` cases plus the 3 new `sortedSubAgents` cases.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/agent-order.ts packages/web/src/lib/agent-order.test.ts
git commit -m "refactor(web): extract sortedSubAgents shared sort helper"
```

---

### Task 2: Rewrite `SidebarAgentTabs` as a scrollable strip + CSS

**Files:**
- Modify: `packages/web/src/components/SidebarAgentTabs.tsx` (full rewrite, props unchanged)
- Modify: `packages/web/src/App.css` (the `.sidebar-agent-tabs` block, around lines 1553–1638)

**Interfaces:**
- Consumes: `sortedSubAgents` from Task 1; existing `GENERAL_ID` (`lib/agent-order.js`), `AGENT_ICONS`, `agentIconKind` (`lib/agent-icons.js`).
- Produces: `SidebarAgentTabs({ agents, activeId, onSwitch, disabled })` — identical props to today, so `Sidebar.tsx` needs no change. New CSS classes `.agent-tab-strip`, `.agent-tab-strip.is-overflowing`.

- [ ] **Step 1: Rewrite the component**

Replace the entire content of `packages/web/src/components/SidebarAgentTabs.tsx` with:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "../api/client.js";
import { GENERAL_ID, sortedSubAgents } from "../lib/agent-order.js";
import { AGENT_ICONS, agentIconKind } from "../lib/agent-icons.js";

interface SidebarAgentTabsProps {
  /** 已安装 agents(含 general);组件内部负责排序。 */
  agents: Agent[];
  activeId: string;
  onSwitch: (agentId: string) => void;
  disabled?: boolean;
}

/** 容忍滚动位置的亚像素误差。 */
const EDGE_EPSILON = 1;

export function SidebarAgentTabs({ agents, activeId, onSwitch, disabled }: SidebarAgentTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const general = agents.find((a) => a.id === GENERAL_ID) ?? null;
  const subs = sortedSubAgents(agents);

  const syncScrollState = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setOverflowing(el.scrollWidth > el.clientWidth + EDGE_EPSILON);
    setCanPrev(el.scrollLeft > EDGE_EPSILON);
    setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - EDGE_EPSILON);
  }, []);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    syncScrollState();
    const ro = new ResizeObserver(syncScrollState);
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncScrollState, subs.length]);

  // 跟随只发生在激活项变化时;手动滚动不会被夹回。
  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>(".agent-tab.active");
    active?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  }, [activeId]);

  const nudge = (dir: 1 | -1) => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

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

  return (
    <div className="sidebar-agent-tabs">
      {general && renderTab(general)}
      {overflowing && (
        <button
          type="button"
          className="agent-tab-arrow"
          onClick={() => nudge(-1)}
          disabled={disabled || !canPrev}
          title="向前滚动"
          aria-label="向前滚动"
        >
          ‹
        </button>
      )}
      <div
        className={`agent-tab-strip ${overflowing ? "is-overflowing" : ""}`}
        ref={stripRef}
        onScroll={syncScrollState}
      >
        {subs.map(renderTab)}
      </div>
      {overflowing && (
        <button
          type="button"
          className="agent-tab-arrow"
          onClick={() => nudge(1)}
          disabled={disabled || !canNext}
          title="向后滚动"
          aria-label="向后滚动"
        >
          ›
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update the CSS**

In `packages/web/src/App.css`:

(a) Replace the `.agent-tab` opening rule's `flex: 1 1 0;` (line ~1561) with `flex: 1 0 auto;` and add `min-width: 76px;` right after it — tabs grow to fill when few, keep intrinsic width (and overflow) when many:

```css
.agent-tab {
  flex: 1 0 auto;
  min-width: 76px;
  ...rest unchanged...
}
```

(b) Insert a new block between the `.sidebar-agent-tabs` rule and `.agent-tab`:

```css
.agent-tab-strip {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  /* 给 hover 的 translateY(-2px) 留出空间,避免被滚动容器裁剪 */
  padding: 4px 2px;
  margin: -4px -2px;
}
.agent-tab-strip::-webkit-scrollbar { display: none; }
/* mask 渐隐只在真的溢出时启用;mask 的颜色只取 alpha 通道,#000 不是渲染色,不影响主题 */
.agent-tab-strip.is-overflowing {
  -webkit-mask-image: linear-gradient(to right, transparent, #000 12px, #000 calc(100% - 12px), transparent);
  mask-image: linear-gradient(to right, transparent, #000 12px, #000 calc(100% - 12px), transparent);
}
```

No other rules change (`.agent-tab.active`, `.agent-tab-icon*`, `.agent-tab-label`, `.agent-tab-arrow` all stay).

- [ ] **Step 3: Type-check and build**

Run: `npm run build -w @lot-agent/web`
Expected: `tsc -b && vite build` succeeds with no errors.

- [ ] **Step 4: Manual verification**

Run `npm run dev:web` (server on :3000 assumed running, or at least the login page renders the sidebar after auth) and check in the browser:
- With ≥3 sub-agents: strip scrolls freely by trackpad/wheel; both arrows render; `‹` grays out at the left edge, `›` at the right edge; clicking an arrow smooth-scrolls ~80% of the strip width — **and crucially, `›` works while the active tab is leftmost** (the original bug).
- Clicking a tab (or switching from the above-input pill row) smooth-scrolls the active tab into view; afterwards you can still scroll it back out of view manually.
- With ≤2 sub-agents (uninstall extras via agent center, or narrow check): no arrows, no edge fade, tabs fill the row width.
- Hover lift (`translateY(-2px)`) is not clipped by the strip; edge fade looks right in both light and dark themes.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/SidebarAgentTabs.tsx packages/web/src/App.css
git commit -m "feat(web): sidebar agent tabs scroll natively; arrows become nudges"
```

---

### Task 3: Delete `windowSubAgents` and its tests

**Files:**
- Modify: `packages/web/src/lib/agent-order.ts`
- Modify: `packages/web/src/lib/agent-order.test.ts`

**Interfaces:**
- Consumes: nothing new. After Task 2, `SidebarAgentTabs` no longer imports `windowSubAgents` — verify before deleting.
- Produces: `agent-order.ts` exports only `GENERAL_ID`, `MAX_VISIBLE_SUBAGENTS`, `SplitAgents`, `splitInstalledAgents`, `sortedSubAgents`.

- [ ] **Step 1: Verify there are no remaining consumers**

Run: `grep -rn "windowSubAgents\|AGENT_TAB_WINDOW\|AgentTabView" packages/web/src --include="*.ts" --include="*.tsx"`
Expected: hits only in `lib/agent-order.ts` and `lib/agent-order.test.ts`. If anything else appears, stop and fix that consumer first.

- [ ] **Step 2: Delete the dead code**

- In `agent-order.ts`: delete `AGENT_TAB_WINDOW`, the `AgentTabView` interface, and the whole `windowSubAgents` function (with its doc comment).
- In `agent-order.test.ts`: delete the entire `describe("windowSubAgents", ...)` block and drop `windowSubAgents, AGENT_TAB_WINDOW` from the import on line 2:

```ts
import { describe, it, expect } from "vitest";
import { splitInstalledAgents, MAX_VISIBLE_SUBAGENTS, sortedSubAgents } from "./agent-order.js";
```

- [ ] **Step 3: Run tests and build**

Run: `npx vitest run packages/web/src/lib/agent-order.test.ts && npm run build -w @lot-agent/web`
Expected: all `splitInstalledAgents` + `sortedSubAgents` tests PASS; `tsc -b && vite build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/agent-order.ts packages/web/src/lib/agent-order.test.ts
git commit -m "refactor(web): delete windowSubAgents windowed paging (dead code)"
```

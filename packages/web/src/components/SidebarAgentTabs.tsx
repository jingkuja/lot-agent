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
    // 翻一整页(正好两个子标签),配合 scroll-snap 落在下一组起点。
    el.scrollBy({ left: dir * el.clientWidth, behavior: "smooth" });
  };

  const renderTab = (a: Agent, pinned = false) => {
    const kind = agentIconKind(a);
    return (
      <button
        key={a.id}
        type="button"
        className={`agent-tab ${pinned ? "agent-tab--general" : ""} ${a.id === activeId ? "active" : ""}`}
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
      {general && renderTab(general, true)}
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
        {subs.map((a) => renderTab(a))}
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

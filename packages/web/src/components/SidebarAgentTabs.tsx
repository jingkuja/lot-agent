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

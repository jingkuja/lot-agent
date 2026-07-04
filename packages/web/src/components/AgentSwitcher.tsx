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

import type { Agent } from "../api/client.js";

interface AgentSwitcherProps {
  /** Agents in display order (general is always first — caller guarantees). */
  agents: Agent[];
  activeId: string;
  onSwitch: (agentId: string) => void;
  disabled?: boolean;
}

export function AgentSwitcher({ agents, activeId, onSwitch, disabled }: AgentSwitcherProps) {
  return (
    <div className="agent-switcher">
      {agents.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`agent-pill ${a.id === activeId ? "active" : ""}`}
          onClick={() => onSwitch(a.id)}
          disabled={disabled}
          title={a.description}
        >
          {a.name}
        </button>
      ))}
    </div>
  );
}

import type { ReactNode } from "react";
import type { Agent } from "../api/client.js";

interface AgentSwitcherProps {
  /** Agents in display order (general is always first — caller guarantees). */
  agents: Agent[];
  activeId: string;
  onSwitch: (agentId: string) => void;
  disabled?: boolean;
}

/** Per-agent glyph for the pill icon badge. Keyed by agent type (id fallback). */
const ICONS: Record<string, ReactNode> = {
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
};

function kindOf(a: Agent): string {
  const key = a.type || a.id;
  return key in ICONS ? key : "general";
}

export function AgentSwitcher({ agents, activeId, onSwitch, disabled }: AgentSwitcherProps) {
  return (
    <div className="agent-switcher">
      {agents.map((a) => {
        const kind = kindOf(a);
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
              {ICONS[kind]}
            </span>
            <span className="agent-pill-label">{a.name}</span>
          </button>
        );
      })}
    </div>
  );
}

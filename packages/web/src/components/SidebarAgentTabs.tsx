import { useI18n } from "../i18n/index.js";
import { useEffect, useId, useRef, useState } from "react";
import type { Agent } from "../api/client.js";
import { GENERAL_ID, sortedSubAgents } from "../lib/agent-order.js";
import { AGENT_ICONS, agentIconKind } from "../lib/agent-icons.js";

interface SidebarAgentTabsProps {
  agents: Agent[];
  activeId: string;
  onSwitch: (agentId: string) => void;
  disabled?: boolean;
}

/** Show three quick choices by default; expand to browse all available Agents. */
export function SidebarAgentTabs({ agents, activeId, onSwitch, disabled }: SidebarAgentTabsProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const gridId = useId();
  const current = agents.find((agent) => agent.id === activeId);
  const general = agents.find((agent) => agent.id === GENERAL_ID);
  const ordered = [...(general ? [general] : []), ...sortedSubAgents(agents)];
  const visible = open ? ordered : ordered.slice(0, 3);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const icon = (agent: Agent) => (
    <span className={`agent-pill-icon agent-pill-icon--${agentIconKind(agent)}`} aria-hidden>
      {AGENT_ICONS[agentIconKind(agent)]}
    </span>
  );

  return (
    <div className="sidebar-agent-picker" ref={root} onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    }}>
      <div className="sidebar-current-agent">
        {current && icon(current)}
        <div className="sidebar-current-agent-copy">
          <span>{t("当前 Agent")}</span>
          <strong>{current ? t(current.name) : t("加载中…")}</strong>
        </div>
        {ordered.length > 3 && <button ref={trigger} type="button" className={`agent-grid-toggle ${open ? "active" : ""}`}
          aria-expanded={open} aria-controls={gridId} aria-label={t(open ? "收起" : "更多")}
          title={t("切换 Agent")} disabled={disabled} onClick={() => setOpen((value) => !value)}>
          <span className="agent-grid-toggle-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden>
              {[4, 10, 16].flatMap((x) => [4, 10, 16].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="4" height="4" rx="1" />))}
            </svg>
          </span>
          <span>{t(open ? "收起" : "更多")}</span>
        </button>}
      </div>
      <div className="agent-launcher" id={gridId}>
        <div className="agent-launcher-grid" role="group" aria-label={t("选择 Agent")}>
          {visible.map((agent) => (
            <button key={agent.id} type="button"
              className={`agent-launcher-item ${agent.id === activeId ? "active" : ""}`}
              aria-pressed={agent.id === activeId} title={t(agent.description)} disabled={disabled}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                onSwitch(agent.id);
              }}>
              {icon(agent)}
              <span>{t(agent.name)}</span>
              {agent.id === activeId && <span className="agent-launcher-check" aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

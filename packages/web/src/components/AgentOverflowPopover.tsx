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

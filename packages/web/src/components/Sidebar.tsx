import { useMemo } from "react";
import type { Agent, Conversation } from "../api/client.js";

interface SidebarProps {
  conversations: Conversation[];
  agents: Agent[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Short label + CSS modifier per agent type, for the per-conversation tag. */
const TAG_BY_TYPE: Record<string, { label: string; mod: string }> = {
  general: { label: "通用", mod: "general" },
  copywriting: { label: "文案", mod: "copy" },
  image: { label: "图片", mod: "image" },
  video: { label: "视频", mod: "video" },
};

export function Sidebar({
  conversations,
  agents,
  activeId,
  onSelect,
  onDelete,
}: SidebarProps) {
  // Map an agent_id to its tag (label + color modifier). Falls back to the
  // agent's own name when the type is unknown, then to a neutral "通用".
  const tagFor = useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a]));
    return (agentId: string) => {
      const agent = byId.get(agentId);
      const byType = agent && TAG_BY_TYPE[agent.type];
      if (byType) return byType;
      if (agent) return { label: agent.name.slice(0, 2), mod: "general" };
      return TAG_BY_TYPE.general;
    };
  }, [agents]);

  return (
    <aside className="sidebar">
      <div className="sidebar-list">
        {conversations.map((conv) => {
          const tag = tagFor(conv.agent_id);
          return (
            <div
              key={conv.id}
              className={`sidebar-item ${conv.id === activeId ? "active" : ""}`}
              onClick={() => onSelect(conv.id)}
            >
              <span className="sidebar-item-title">{conv.title}</span>
              <span className={`agent-tag agent-tag--${tag.mod}`}>{tag.label}</span>
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
          );
        })}
      </div>
    </aside>
  );
}

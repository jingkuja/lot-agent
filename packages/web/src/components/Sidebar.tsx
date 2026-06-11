import type { Conversation } from "../api/client.js";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>Conversations</h2>
        <button onClick={onCreate} className="btn-new">
          + New Chat
        </button>
      </div>
      <div className="sidebar-list">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`sidebar-item ${conv.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(conv.id)}
          >
            <span className="sidebar-item-title">{conv.title}</span>
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
        ))}
      </div>
    </aside>
  );
}

import type { User } from "../api/client.js";

interface StatusBarProps {
  isStreaming: boolean;
  user?: User;
  onLogout?: () => void;
}

export function StatusBar({ isStreaming, user, onLogout }: StatusBarProps) {
  return (
    <footer className="status-bar">
      <span>
        <span className={`status-dot ${isStreaming ? "busy" : "ready"}`} />
        {isStreaming ? "Thinking..." : "Ready"}
      </span>
      <span className="status-right">
        {user && (
          <span className="status-user">{user.email}</span>
        )}
        {user && onLogout && (
          <button className="btn-logout" onClick={onLogout}>
            退出
          </button>
        )}
        {!user && <span>Lot Agent v0.1.0</span>}
      </span>
    </footer>
  );
}

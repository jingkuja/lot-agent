interface StatusBarProps {
  isStreaming: boolean;
}

export function StatusBar({ isStreaming }: StatusBarProps) {
  return (
    <footer className="status-bar">
      <span>
        <span className={`status-dot ${isStreaming ? "busy" : "ready"}`} />
        {isStreaming ? "Thinking..." : "Ready"}
      </span>
      <span>Lot Agent v0.1.0</span>
    </footer>
  );
}

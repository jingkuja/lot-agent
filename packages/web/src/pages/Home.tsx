import { useEffect, useState } from "react";
import { api, type Agent } from "../api/client.js";

interface HomeProps {
  onPick: (agent: Agent) => void;
}

export function Home({ onPick }: HomeProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listAgents()
      .then(setAgents)
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="home-page">
      <div className="home-header">
        <h1>选择 Agent</h1>
        <p>选择一个 Agent 开始创作</p>
      </div>

      {loading && (
        <div className="home-loading">
          <span>加载中...</span>
        </div>
      )}

      {error && (
        <div className="home-error">{error}</div>
      )}

      {!loading && !error && agents.length === 0 && (
        <div className="home-empty">暂无可用 Agent</div>
      )}

      {!loading && !error && agents.length > 0 && (
        <div className="agent-grid">
          {agents.map((agent) => (
            <button
              key={agent.id}
              className="agent-card"
              onClick={() => onPick(agent)}
            >
              <div className="agent-card-header">
                <span className="agent-type-badge">{agent.type}</span>
              </div>
              <h3 className="agent-card-name">{agent.name}</h3>
              <p className="agent-card-desc">{agent.description}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

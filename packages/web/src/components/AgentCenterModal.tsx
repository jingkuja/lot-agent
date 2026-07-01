import { useMemo } from "react";
import type { Agent } from "../api/client.js";
import { GENERAL_ID } from "../lib/agent-order.js";

interface Props {
  agents: Agent[];
  onInstall: (id: string) => void;
  onUninstall: (id: string) => void;
  onClose: () => void;
  busyId?: string | null;
}

/** Agent 中心:卡片网格市场,按 category 分组,安装 / 卸载。 */
export function AgentCenterModal({ agents, onInstall, onUninstall, onClose, busyId }: Props) {
  const groups = useMemo(() => {
    const m = new Map<string, Agent[]>();
    for (const a of agents) {
      if (a.id === GENERAL_ID) continue; // 通用是基础能力,不在市场展示
      const key = a.category ?? "其他";
      (m.get(key) ?? m.set(key, []).get(key)!).push(a);
    }
    return [...m.entries()];
  }, [agents]);

  return (
    <div className="agent-center-overlay" onClick={onClose}>
      <div className="agent-center-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Agent 中心">
        <div className="agent-center-head">
          <span className="agent-center-title">Agent 中心</span>
          <button className="agent-center-close" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="agent-center-body">
          {groups.map(([category, list]) => (
            <section key={category} className="agent-center-group">
              <div className="agent-center-group-label">{category}</div>
              <div className="agent-center-grid">
                {list.map((a) => {
                  const isGeneral = a.id === "general";
                  const busy = busyId === a.id;
                  return (
                    <div key={a.id} className="agent-card">
                      <div className="agent-card-name">{a.name}</div>
                      <div className="agent-card-desc">{a.description || "暂无描述"}</div>
                      <div className="agent-card-footer">
                        {a.installed ? (
                          <button
                            className="agent-card-btn installed"
                            disabled={isGeneral || busy}
                            onClick={() => onUninstall(a.id)}
                            title={isGeneral ? "通用助手不可卸载" : "卸载"}
                          >
                            {isGeneral ? "默认" : busy ? "处理中…" : "已安装 · 卸载"}
                          </button>
                        ) : (
                          <button
                            className="agent-card-btn"
                            disabled={busy}
                            onClick={() => onInstall(a.id)}
                          >
                            {busy ? "处理中…" : "安装"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

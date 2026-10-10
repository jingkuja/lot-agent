import { useState } from "react";
import { api, type AgentRunRecord } from "../api/client.js";
import { useI18n } from "../i18n/index.js";

/** A human verifies business results; the model cannot clear uncertain writes. */
export function RunRecoveryCard({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<AgentRunRecord[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const load = async () => {
    setBusy(true); setError(false);
    try { setRuns((await api.getAgentRuns(conversationId)).runs); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const verify = async (id: string, outcome: "succeeded" | "failed") => {
    setBusy(true); setError(false);
    try {
      await api.verifyAgentOperation(conversationId, id, outcome);
      setRuns((await api.getAgentRuns(conversationId)).runs);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const pending = runs?.flatMap(run => run.steps).filter(step => step.status === "unknown_outcome");
  return <details className="tool-calls-section">
    <summary onClick={() => { if (!runs && !busy) void load(); }}>{t("核实操作结果")}</summary>
    <p>{t("请先检查业务记录或生成结果，再选择实际发生的情况。此处不会重新执行操作。")}</p>
    {pending?.map(step => <div key={step.id} className="message-content">
      <strong>{step.tool_name}</strong>
      <pre className="tool-output">{JSON.stringify(step.input, null, 2)}</pre>
      {step.result?.content && <pre className="tool-output">{step.result.content}</pre>}
      <button type="button" disabled={busy} onClick={() => void verify(step.id, "succeeded")}>{t("已核实完成")}</button>
      <button type="button" disabled={busy} onClick={() => void verify(step.id, "failed")}>{t("已核实未执行，允许重试")}</button>
    </div>)}
    {pending?.length === 0 && <p>{t("没有待核实的操作")}</p>}
    {error && <p role="alert">{t("暂时无法更新，请等待本轮结束后重试")}</p>}
    <button type="button" disabled={busy} onClick={() => void load()}>{t("刷新")}</button>
  </details>;
}

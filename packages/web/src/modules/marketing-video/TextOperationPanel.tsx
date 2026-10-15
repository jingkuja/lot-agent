import { useEffect, useRef, useState } from "react";
import type { MarketingDraft } from "@lot-agent/core/marketing-video";
import { request } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";

type Operation = { id: string; status: string; appliedVersion?: number; result?: { draft: MarketingDraft; analysis: string } };
export function TextOperationPanel({ projectId, reload, onState }: {
  projectId: string; reload: number; onState(operation?: Operation): Promise<void>;
}) {
  const { t } = useI18n(); const [operations, setOperations] = useState<Operation[]>([]);
  const callback = useRef(onState); callback.current = onState;
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let again = true;
      try {
        const { data } = await request<{ data: Operation[] }>(`/marketing-videos/${projectId}/text-operations`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setOperations(data); setError(false); await callback.current(data[0]);
        again = ["running", "unknown", "needs_apply"].includes(data[0]?.status ?? "");
      } catch { if (!controller.signal.aborted) setError(true); }
      if (!controller.signal.aborted && again) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, reload, refresh]);
  async function recover(id: string) {
    if (recovering) return;
    setRecovering(true); setRecoveryError("");
    try { await request(`/marketing-videos/${projectId}/text-operations/${id}/recover`, { method: "POST" }); }
    catch (error) { setRecoveryError(error instanceof Error ? error.message : "操作失败，请稍后重试。"); }
    finally { setRecovering(false); setRefresh(n => n + 1); }
  }
  return <div className="ma-panel" aria-live="polite">
    {error && <p>{t("暂时无法查询进度，正在重试；请勿重复生成。")}</p>}
    {operations[0]?.status === "running" && <p>{t("正在生成文案和分镜")}…</p>}
    {operations[0]?.status === "unknown" && <p role="alert">{t("创作请求结果待核实，已阻止重复调用；请联系管理员核对上游回执。")}</p>}
    {operations[0]?.status === "needs_apply" && <p role="status">{t("完整创作回执已保存，可恢复结果，无需再次调用模型。")}</p>}
    {!!operations.length && <><p>{t("操作编号")}：{operations[0].id}</p><button disabled={recovering} onClick={() => setRefresh(n => n + 1)}>{t("刷新创作状态")}</button></>}
    {operations[0]?.status === "needs_apply" && <button disabled={recovering} onClick={() => void recover(operations[0].id)}>{t("恢复已收到的结果")}</button>}
    {recoveryError && <p role="alert">{t(recoveryError)}</p>}
    {!!operations.length && <details onToggle={e => setExpanded(e.currentTarget.open)}><summary>{t("保存的创作记录")}</summary>{expanded && operations.map(operation => <article key={operation.id}>
      <p>{t(({ succeeded: "创作结果已保存", conflict: "草稿已更新，创作结果单独保留", needs_apply: "完整创作回执已保存，可恢复结果，无需再次调用模型。", failed: "创作未完成，再次生成可能产生费用。", unknown: "创作请求结果待核实，已阻止重复调用；请联系管理员核对上游回执。", running: "正在生成文案和分镜" } as Record<string, string>)[operation.status] ?? operation.status)}</p>
      <p>{t("操作编号")}：{operation.id}</p>
      {operation.result && <><p>{operation.result.analysis}</p><pre>{operation.result.draft.script}</pre>{operation.result.draft.storyboard.map((shot, index) => <p key={index}>{shot.durationSec}s · {shot.visual} · {shot.action} · {shot.camera}</p>)}</>}
    </article>)}</details>}
  </div>;
}

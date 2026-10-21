import { useEffect, useRef, useState } from "react";
import type { MarketingDraft, MarketingReview } from "@lot-agent/core/marketing-video";
import { request } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { useConfirm } from "./ConfirmDialog.js";
import { WaitStatus } from "./WaitStatus.js";

type Operation = { id: string; kind?: "copy" | "storyboard" | "review" | "publication"; status: string; createdAt?: string; appliedVersion?: number; result?: { draft?: MarketingDraft; analysis?: string; review?: MarketingReview } };
const RUNNING: Record<string, string> = { review: "正在检查文案与分镜", publication: "正在生成标题和标签" };
export function TextOperationPanel({ projectId, reload, showRunning = true, onState, retry }: {
  projectId: string; reload: number;
  /** False while the page already shows its own progress for this request. */
  showRunning?: boolean;
  onState(operation?: Operation): Promise<void>;
  /** The request this page can repeat; `run` is called after its unknown result is discarded. */
  retry?: { kind: string; run(): void };
}) {
  const { t } = useI18n(); const [operations, setOperations] = useState<Operation[]>([]);
  const callback = useRef(onState); callback.current = onState;
  const [confirmDialog, confirm] = useConfirm();
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  // Each received result is applied once without asking; a failure leaves a retry button.
  const autoRecovered = useRef(new Set<string>());
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
  async function release(id: string, again = false) {
    if (recovering || !await confirm(again
      ? { title: "放弃并重新生成？", message: "上次 AI 创作可能已经计费。放弃这次结果并重新生成会再次计费。确定继续吗？", confirm: "放弃并重新生成" }
      : { title: "放弃这次结果？", message: "上次 AI 创作可能已经计费。放弃这次结果后可以重新创作，但会再次计费。确定放弃吗？", confirm: "放弃这次结果" })) return;
    setRecovering(true); setRecoveryError("");
    let released = false;
    try { await request(`/marketing-videos/${projectId}/text-operations/${id}/release`, { method: "POST" }); released = true; }
    catch (error) { setRecoveryError(error instanceof Error ? error.message : "操作失败，请稍后重试。"); }
    finally { setRecovering(false); setRefresh(n => n + 1); }
    // The page repeats the request once the refreshed state unlocks it.
    if (released && again) retry?.run();
  }
  async function recover(id: string) {
    if (recovering) return;
    setRecovering(true); setRecoveryError("");
    try { await request(`/marketing-videos/${projectId}/text-operations/${id}/recover`, { method: "POST" }); }
    catch (error) { setRecoveryError(error instanceof Error ? error.message : "操作失败，请稍后重试。"); }
    finally { setRecovering(false); setRefresh(n => n + 1); }
  }
  const latest = operations[0];
  // Applying a received result never calls the model, so it needs no confirmation.
  useEffect(() => {
    if (latest?.status !== "needs_apply" || autoRecovered.current.has(latest.id)) return;
    autoRecovered.current.add(latest.id);
    void recover(latest.id);
  }, [latest?.id, latest?.status]);
  return <div className="ma-panel" aria-live="polite">
    {error && <p>{t("暂时无法查询进度，正在自动重试；无需重复生成。")}</p>}
    {latest?.status === "running" && showRunning && (latest.createdAt
      ? <WaitStatus key={latest.id} label={RUNNING[latest.kind ?? ""] ?? "正在生成文案和分镜"} started={Date.parse(latest.createdAt)} />
      : <p>{t(RUNNING[latest.kind ?? ""] ?? "正在生成文案和分镜")}…</p>)}
    {latest?.status === "unknown" && <>
      <p role="alert">{t("上次 AI 创作没有收到明确结果，可能已经计费。为避免重复扣费，系统不会自动重试。可以放弃这次结果后重新创作（会再次计费）。")}</p>
      <div className="mv-choices">
        {retry?.kind === latest.kind && <button className="mv-primary" disabled={recovering} onClick={() => void release(latest.id, true)}>{t("放弃并重新生成")}</button>}
        <button disabled={recovering} onClick={() => void release(latest.id)}>{t("放弃这次结果")}</button>
      </div>
    </>}
    {latest?.status === "needs_apply" && <>
      <p role="status">{t(recovering ? "正在填入 AI 创作结果，不会再次扣费…" : "AI 创作结果已收到，可填入草稿，不会再次扣费。")}</p>
      {!recovering && recoveryError && <button className="mv-primary" onClick={() => void recover(latest.id)}>{t("重新填入")}</button>}
    </>}
    {recoveryError && <p role="alert">{t(recoveryError)}</p>}
    {confirmDialog}
  </div>;
}

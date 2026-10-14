import { useEffect, useRef, useState } from "react";
import type { ReferenceAnalysis } from "@lot-agent/core/marketing-analysis";
import { ApiClientError, getToken, request } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";

const base = "/marketing-video-analyses";
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const active = (value: ReferenceAnalysis) => ["queued", "running"].includes(value.status);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
export function analysisError(value: unknown) {
  const code = value instanceof ApiClientError ? value.code : value instanceof Error ? value.message : "";
  return ({
    PROJECT_CONFLICT: "草稿已在其他页面更新，生成结果保留在参考资料中。",
    REQUEST_UNKNOWN: "模型响应中断，已有分析已保存。为避免重复收费，需核实本次请求后继续。",
    MODEL_USAGE_UNKNOWN: "模型响应中断，已有分析已保存。为避免重复收费，需核实本次请求后继续。",
    MODEL_QUOTA: "上游余额不足，请充值后继续。",
    MODEL_RATE_LIMIT: "上游服务繁忙，请稍后继续。",
    MODEL_AUTH_REQUIRED: "模型服务未授权，请检查账号配置。",
    MODEL_STEP_FAILED: "文案整理未完成，点击继续生成将复用已有资料。",
    MODEL_INVALID_JSON: "文案整理未完成，点击继续生成将复用已有资料。",
    MODEL_INVALID_EVIDENCE: "文案整理未完成，点击继续生成将复用已有资料。",
    EVIDENCE_OUTSIDE_TIMELINE: "文案整理未完成，点击继续生成将复用已有资料。",
    ANALYSIS_IMAGE_BUDGET_EXHAUSTED: "画面处理已暂停，点击继续生成将复用已有资料。",
    AUTH_REQUIRED: "该视频需要平台登录，请补充登录信息后继续。",
    CHALLENGE_REQUIRED: "请先在视频平台完成验证，再继续。",
    DURATION_LIMIT: "参考视频最长 180 秒。",
    SANDBOX_REQUIRED: "服务器的媒体隔离环境不可用，请联系管理员。",
    ANALYSIS_DISABLED: "参考视频分析尚未启用。",
    INVALID_SOURCE: "请填写抖音、小红书或 B 站视频链接，也可以直接粘贴文案。",
    UNSUPPORTED_PLATFORM: "请填写抖音、小红书或 B 站视频链接，也可以直接粘贴文案。",
  } as Record<string, string>)[code ?? ""] ?? "处理未完成，已有结果已保留，请稍后继续。";
}

/** Progress and optional source material only. The worker writes the result to
 * the draft; opening or refreshing this component never starts a model call. */
export function ReferenceAnalysisPanel({ id, ownerId, onActive, onComplete }: {
  id: string; ownerId: string; onActive(value: boolean): void; onComplete(value: ReferenceAnalysis): Promise<void>;
}) {
  const { t } = useI18n();
  const callbacks = useRef({ onActive, onComplete }); callbacks.current = { onActive, onComplete };
  const [current, setCurrent] = useState<ReferenceAnalysis | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [frameId, setFrameId] = useState(""); const [frameUrl, setFrameUrl] = useState("");
  const [cookies, setCookies] = useState(""); const [reload, setReload] = useState(0);
  const completed = useRef(""); const alive = useRef(true); const locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let again = true;
      try {
        const value = await request<ReferenceAnalysis>(`${base}/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setCurrent(value); setError("");
        if (value.applied && completed.current !== `${id}:${value.revision}`) {
          await callbacks.current.onComplete(value);
          if (controller.signal.aborted) return;
          completed.current = `${id}:${value.revision}`;
        }
        callbacks.current.onActive(active(value)); again = !!active(value);
      } catch { if (!controller.signal.aborted) setError("暂时无法查询进度，正在重试；请勿重复生成。"); }
      if (!controller.signal.aborted && again) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, ownerId, reload]);
  useEffect(() => {
    setFrameUrl(""); if (!frameId) return;
    const controller = new AbortController(); let url = "";
    void fetch(`/api${base}/${id}/frames/${frameId}`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` }, signal: controller.signal }).then(async res => {
      if (!res.ok) throw new Error("EVIDENCE_NOT_FOUND"); const blob = await res.blob();
      if (controller.signal.aborted) return; url = URL.createObjectURL(blob); setFrameUrl(url);
    }).catch(() => { if (!controller.signal.aborted) setError("参考画面暂时无法加载。"); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [id, frameId]);
  async function act(operation: () => Promise<unknown>) {
    if (locked.current) return; locked.current = true; setBusy(true); setError("");
    try { await operation(); if (alive.current) setReload(n => n + 1); }
    catch (e) { if (alive.current) setError(analysisError(e)); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  const stage = current ? ({ queued: "等待处理", downloaded: "正在读取视频", frames: "正在读取视频", ocr: "正在理解视频内容", visual: "正在理解视频内容", summary: "正在整理文案结构", copy: "正在生成文案和分镜" } as Record<string, string>)[current.stage] ?? "正在理解视频内容" : "正在读取视频";
  const canResume = current && !active(current) && !["ready", "needs_review"].includes(current.status) && current.errorCode !== "REQUEST_UNKNOWN";
  return <div className="ma-panel" aria-live="polite">
    {(!current || active(current)) && <p role="status">{t(stage)}…</p>}
    {current && active(current) && <button disabled={busy} onClick={() => void act(() => request(`${base}/${id}/cancel`, json({})))}>{t("取消")}</button>}
    {current?.errorCode && <p className="mv-error" role="alert">{t(analysisError(new Error(current.errorCode)))}</p>}
    {current?.status === "cancelled" && <p>{t("已取消")}</p>}
    {canResume && <button disabled={busy} onClick={() => void act(async () => {
      await request(`${base}/${id}/resume`, json({ expectedRevision: current.revision })); callbacks.current.onActive(true);
    })}>{t("继续生成")}</button>}
    {current?.status === "needs_auth" && <details><summary>{t("补充平台登录信息")}</summary>
      <label className="mv-field"><span>{t("个人平台 Cookies（Netscape 格式）")}</span><textarea rows={3} value={cookies} onChange={e => setCookies(e.target.value)} /></label>
      <button disabled={busy || !cookies.trim()} onClick={() => void act(async () => {
        await request(`${base}/sessions/${current.snapshot.source.platform}`, { method: "PUT", body: JSON.stringify({ cookies }) });
        setCookies(""); await request(`${base}/${id}/resume`, json({ expectedRevision: current.revision })); callbacks.current.onActive(true);
      })}>{t("保存并继续")}</button>
      <button disabled={busy} onClick={() => void act(() => request(`${base}/sessions/${current.snapshot.source.platform}`, { method: "DELETE" }))}>{t("清除平台登录信息")}</button>
    </details>}
    {current && <details className="mv-script-review"><summary>{t("查看参考资料")}</summary>
      <p>{current.snapshot.source.title}</p>
      {current.snapshot.summary?.summary.map((item, i) => <p key={i}>{item.statement}</p>)}
      {current.snapshot.summary?.marketingPoints.map((item, i) => <p key={i}>{item.statement}</p>)}
      {current.errorCode === "PROJECT_CONFLICT" && current.snapshot.creation && <><p>{current.snapshot.creation.analysis}</p><pre>{current.snapshot.creation.draft.script}</pre>{current.snapshot.creation.draft.storyboard.map((shot, i) => <article key={i}><p>{shot.visual}</p><p>{shot.action}</p><p>{shot.camera}</p></article>)}</>}
      {!!current.snapshot.texts.length && <details><summary>{t("画面文字")}</summary>{current.snapshot.texts.map(text => <p key={text.id}>{seconds(text.firstSeenMs)} · {text.text}</p>)}</details>}
      {!!current.snapshot.frames.length && <details><summary>{t("参考画面")}</summary>
        <div className="ma-evidence-links">{current.snapshot.frames.map(frame => <button key={frame.id} aria-pressed={frameId === frame.id} onClick={() => setFrameId(frame.id)}>{seconds(frame.ptsMs)}</button>)}</div>
        {frameUrl && <img className="ma-frame" src={frameUrl} alt={t("参考画面")} />}
      </details>}
      <p className="mv-hint">{t("依据视频画面和可见文字生成；原始声音未转录，分镜为 AI 创作建议。")}</p>
    </details>}
    {error && <p className="mv-error" role="alert">{t(error)}</p>}
  </div>;
}

import { useEffect, useRef, useState } from "react";
import type { ReferenceAnalysis } from "@lot-agent/core/marketing-analysis";
import { ApiClientError, getToken, request } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";

type ProjectTarget = { projectId: string; projectVersion: number };
type ApplyInput = ProjectTarget & { expectedRevision: number; evidenceIds: string[] };
const base = "/marketing-video-analyses";
const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
const active = (value: ReferenceAnalysis | null) => value && ["queued", "running"].includes(value.status);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function ReferenceAnalysisPanel({ ownerId, canApply, prepareProject, applied, onBusy, disabled = false }: {
  ownerId: string; canApply: boolean; disabled?: boolean; prepareProject(): Promise<ProjectTarget>;
  applied(id: string): Promise<void>; onBusy?(value: boolean): void;
}) {
  const { locale } = useI18n();
  const say = (zh: string, en: string) => locale === "zh" ? zh : en;
  const [caps, setCaps] = useState<{ enabled: boolean; budgetCny: number } | null>(null);
  const [items, setItems] = useState<ReferenceAnalysis[]>([]); const [more, setMore] = useState(false);
  const [current, setCurrent] = useState<ReferenceAnalysis | null>(null);
  const [share, setShare] = useState(""); const nonce = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false); const locked = useRef(false); const alive = useRef(true);
  const [error, setError] = useState<unknown>(null); const [notice, setNotice] = useState<[string, string] | null>(null);
  const [edits, setEdits] = useState<Record<string, string> | null>(null);
  const [selected, setSelected] = useState<string[]>([]); const [frameId, setFrameId] = useState(""); const [frameUrl, setFrameUrl] = useState("");
  const [preview, setPreview] = useState<{ text: string; input: ApplyInput; analysisId: string } | null>(null);
  const [platform, setPlatform] = useState("douyin"); const [cookie, setCookie] = useState("");
  const [sessions, setSessions] = useState<string[]>([]);
  const storageKey = `lot:marketing-analysis:${ownerId}`;
  const status = (value: string) => ({ queued: say("等待分析", "Queued"), running: say("正在分析", "Analyzing"), ready: say("分析完成", "Ready"), partial: say("部分结果", "Partial results"),
    needs_auth: say("需要平台登录", "Platform login required"), needs_review: say("调用结果待核实", "Request needs review"), failed: say("分析失败", "Failed"), cancelled: say("已取消", "Cancelled") })[value] ?? value;
  const stage = (value: string) => ({ queued: say("等待处理", "Waiting"), downloaded: say("下载完成", "Downloaded"), frames: say("抽帧", "Sampling frames"), ocr: say("识别画面文字", "Reading screen text"), visual: say("理解画面", "Observing frames"), summary: say("生成摘要", "Summarizing") })[value] ?? value;
  function errorText(value: unknown) {
    const code = value instanceof ApiClientError ? value.code : value instanceof Error ? value.message : "";
    const labels: Record<string, [string, string]> = {
      REVISION_CONFLICT: ["分析已在其他页面更新，请重新打开后校对。", "This analysis changed in another tab. Reopen it before editing."],
      PROJECT_CONFLICT: ["草稿已更新或已提交制作，请重新预览。", "The draft changed or was submitted. Preview again."],
      REQUEST_UNKNOWN: ["模型调用结果尚未核实，已保留结果；请联系管理员核对用量后继续。", "A model request is unconfirmed. Results are saved; contact an administrator to reconcile usage."],
      MODEL_USAGE_UNKNOWN: ["网关未返回用量，需核实后继续。", "The gateway did not return usage. Reconciliation is required."],
      ANALYSIS_BUDGET_EXHAUSTED: ["分析预算已用完，已保留部分结果。", "The analysis budget is exhausted. Partial results are saved."],
      AUTH_REQUIRED: ["来源需要登录，请导入该平台的个人登录态后继续。", "The source requires login. Import your platform session and resume."],
      CHALLENGE_REQUIRED: ["平台要求人工验证，请先在平台完成验证。", "Complete the platform's verification before continuing."],
      DURATION_LIMIT: ["参考视频最长 180 秒。", "Reference videos must be at most 180 seconds."],
      REFERENCE_TOO_LONG: ["参考内容超过 6000 字符，请减少选中的证据。", "The reference exceeds 6,000 characters. Select fewer evidence items."],
      ANALYSIS_IN_USE: ["此分析已被草稿引用，暂不能删除。", "This analysis is referenced by a draft and cannot be deleted."],
      SANDBOX_REQUIRED: ["服务器的媒体隔离环境不可用，请联系管理员。", "The server's media sandbox is unavailable. Contact an administrator."],
    };
    const label = labels[code ?? ""];
    return label ? say(...label) : say("操作未完成，结果已保留。", "The operation did not complete. Saved results are retained.") + (code && /^[A-Z_]+$/.test(code) ? ` (${code})` : "");
  }
  function accept(value: ReferenceAnalysis, opening = false) {
    setCurrent(value); setItems(old => [value, ...old.filter(item => item.id !== value.id)]);
    if (opening) {
      setEdits(null); setPreview(null); setFrameId("");
      setSelected([...new Set([...value.snapshot.texts.map(t => t.id), ...(value.snapshot.summary?.summary.flatMap(f => f.evidenceIds) ?? [])])].slice(0, 150));
      try { localStorage.setItem(storageKey, value.id); } catch { /* Optional preference. */ }
    }
  }
  async function act(operation: () => Promise<void>) {
    if (locked.current || disabled) return;
    locked.current = true; setBusy(true); onBusy?.(true); setError(null); setNotice(null);
    try { await operation(); } catch (error) { if (alive.current) setError(error); }
    finally { locked.current = false; if (alive.current) { setBusy(false); onBusy?.(false); } }
  }
  async function load(offset = 0, signal?: AbortSignal) {
    const result = await request<{ data: ReferenceAnalysis[] }>(`${base}?offset=${offset}`, { signal });
    if (!alive.current || signal?.aborted) return;
    setItems(old => offset ? [...old, ...result.data.filter(item => !old.some(row => row.id === item.id))] : result.data); setMore(result.data.length === 20);
  }
  async function open(id: string, signal?: AbortSignal) { const value = await request<ReferenceAnalysis>(`${base}/${id}`, { signal }); if (alive.current && !signal?.aborted) accept(value, true); }
  useEffect(() => {
    alive.current = true; const controller = new AbortController();
    void request<{ enabled: boolean; budgetCny: number }>(`${base}/capabilities`, { signal: controller.signal }).then(async value => {
      if (!alive.current || controller.signal.aborted) return; setCaps(value);
      if (!value.enabled) return;
      await load(0, controller.signal);
      if (controller.signal.aborted) return;
      let id: string | null = null; try { id = localStorage.getItem(storageKey); } catch { /* Optional. */ }
      if (id) await open(id, controller.signal).catch(() => {});
      if (controller.signal.aborted) return;
      const session = await request<{ data: { platform: string }[] }>(`${base}/sessions`, { signal: controller.signal });
      if (alive.current && !controller.signal.aborted) setSessions(session.data.map(s => s.platform));
    }).catch(error => { if (alive.current && !controller.signal.aborted) setError(error); });
    return () => { alive.current = false; controller.abort(); onBusy?.(false); };
  }, []);
  useEffect(() => {
    if (!active(current)) return;
    let stopped = false; let querying = false;
    const timer = setInterval(() => {
      if (querying || locked.current) return; querying = true;
      void request<ReferenceAnalysis>(`${base}/${current!.id}`).then(value => { if (!stopped && alive.current) accept(value); })
        .catch(error => { if (!stopped && alive.current) setError(error); }).finally(() => { querying = false; });
    }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [current?.id, current?.status]);
  useEffect(() => {
    setFrameUrl(""); if (!current || !frameId) return;
    const controller = new AbortController(); let url = "";
    void fetch(`/api${base}/${current.id}/frames/${frameId}`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` }, signal: controller.signal }).then(async res => {
      if (!res.ok) throw new Error("EVIDENCE_NOT_FOUND"); const blob = await res.blob();
      if (controller.signal.aborted) return; url = URL.createObjectURL(blob); setFrameUrl(url);
    }).catch(error => { if (!controller.signal.aborted) setError(error); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [current?.id, frameId]);
  const choose = (id: string) => { setPreview(null); setSelected(old => old.includes(id) ? old.filter(value => value !== id) : [...old, id]); };
  const evidence = (ids: string[]) => <span className="ma-evidence-links">{ids.map(id => <button type="button" key={id} onClick={() => {
    const frame = id.startsWith("f") ? id : current?.snapshot.texts.find(t => t.id === id)?.frameIds[0]; if (frame) setFrameId(frame);
  }}>{id}</button>)}</span>;
  const limitation = (code: string) => ({ OCR_INCOMPLETE: say("部分文字识别未完成", "Some text recognition is incomplete"), VISUAL_INCOMPLETE: say("部分画面理解未完成", "Some visual observations are incomplete"), SAMPLED_IMAGES_ONLY: say("只依据抽样画面", "Based on sampled frames"), NO_AUDIO_ANALYSIS: say("未分析声音或实际口播", "Audio and actual speech were not analyzed"), BRIEF_TEXT_MAY_BE_MISSED: say("短暂文字可能漏检", "Brief text may be missed"), OCR_BUDGET_EXHAUSTED: say("部分文字候选帧未识别", "Some text candidate frames were not read"), VISUAL_BUDGET_EXHAUSTED: say("部分场景未送入模型", "Some scenes were not sent to the model") })[code] ?? code;

  return <details className="mv-card ma-panel"><summary>{say("参考视频分析", "Reference video analysis")}</summary>
    <p className="mv-hint">{say("抖音、小红书、B 站 · 最长 180 秒 · 提取画面文字与带证据的摘要", "Douyin, Xiaohongshu, Bilibili · Up to 180 seconds · Screen text and evidence-backed summaries")}</p>
    {caps?.enabled && <p className="mv-hint">{say("原片保留 7 天；证据帧与分析保留到你删除。", "Source videos are retained for 7 days; evidence frames and analyses remain until you delete them.")}</p>}
    {caps && !caps.enabled && <p role="status">{say("参考视频分析尚未启用。", "Reference video analysis is not enabled.")}</p>}
    {caps?.enabled && <>
      <label className="mv-field"><span>{say("视频链接或分享文本", "Video link or share text")}</span><textarea rows={2} maxLength={4000} value={share} disabled={disabled || busy} onChange={e => { setShare(e.target.value); nonce.current = crypto.randomUUID(); }} /></label>
      <p className="mv-hint">{say(`每项分析预留 ¥${caps.budgetCny} 预算，按模型实际用量计费。`, `Each analysis reserves ¥${caps.budgetCny}; charges use actual model usage.`)}</p>
      <button disabled={disabled || busy || !share.trim()} onClick={() => void act(async () => {
        const result = await request<ReferenceAnalysis>(base, json("POST", { shareText: share, clientRequestId: nonce.current }));
        if (alive.current) { accept(result, true); setShare(""); nonce.current = crypto.randomUUID(); }
      })}>{say("开始分析（调用模型）", "Start analysis (uses models)")}</button>
      <details className="ma-sessions"><summary>{say("平台登录态（选填）", "Platform session (optional)")}</summary>
        <p className="mv-hint">{say("仅导入你自己的 Netscape 格式 Cookie；加密保存，可随时撤销。", "Import only your own Netscape cookie file. It is encrypted and can be revoked.")}</p>
        <select aria-label={say("选择平台", "Choose platform")} value={platform} disabled={disabled || busy} onChange={e => { setPlatform(e.target.value); setCookie(""); }}><option value="douyin">{say("抖音", "Douyin")}</option><option value="xiaohongshu">{say("小红书", "Xiaohongshu")}</option><option value="bilibili">{say("B 站", "Bilibili")}</option></select>
        <label className="mv-field"><span>{say("登录态文件内容", "Cookie file contents")}</span><textarea autoComplete="off" spellCheck={false} rows={2} maxLength={65536} value={cookie} disabled={disabled || busy} onChange={e => setCookie(e.target.value)} /></label>
        <button disabled={disabled || busy || !cookie.trim()} onClick={() => void act(async () => { await request(`${base}/sessions/${platform}`, json("PUT", { cookies: cookie })); if (alive.current) { setCookie(""); setSessions(old => [...new Set([...old, platform])]); setNotice(["登录态已保存。", "Session saved."]); } })}>{say("保存登录态", "Save session")}</button>
        <button disabled={disabled || busy || !sessions.includes(platform)} onClick={() => void act(async () => { await request(`${base}/sessions/${platform}`, { method: "DELETE" }); if (alive.current) { setSessions(old => old.filter(p => p !== platform)); setCookie(""); } })}>{say("撤销登录态", "Revoke session")}</button>
      </details>
      <details className="ma-history"><summary>{say("分析历史", "Analysis history")}</summary><div className="mv-draft-list">{items.map(item => <button disabled={disabled || busy || !!edits} key={item.id} aria-pressed={item.id === current?.id} onClick={() => void act(() => open(item.id))}><strong>{item.snapshot.source.title || item.snapshot.source.platform}</strong><span>{status(item.status)} · {new Date(item.createdAt).toLocaleString()}</span></button>)}</div>
        <button disabled={disabled || busy || !!edits} onClick={() => void act(() => load())}>{say("刷新历史", "Refresh history")}</button>{more && <button disabled={disabled || busy || !!edits} onClick={() => void act(() => load(items.length))}>{say("加载更多", "Load more")}</button>}
      </details>
      {current && <article className="ma-result">
        <h3>{current.snapshot.source.title || say("参考视频", "Reference video")}</h3>
        <p role="status">{status(current.status)} · {stage(current.stage)} · {say("修订", "Revision")} {current.revision}</p>
        {current.budget && <p className="mv-hint">{say("已记录费用", "Recorded cost")}: ¥{current.budget.spent.toFixed(4)} · {say("预算", "Budget")}: ¥{current.budget.limit}</p>}
        {current.errorCode && <p className="mv-error" role="alert">{errorText(new ApiClientError(current.errorCode, 409, current.errorCode))}</p>}
        <div className="mv-choices">
          {active(current) && <button disabled={disabled || busy} onClick={() => void act(async () => { const result = await request<ReferenceAnalysis>(`${base}/${current.id}/cancel`, json("POST", {})); if (alive.current) accept(result); })}>{say("取消分析", "Cancel analysis")}</button>}
          {!active(current) && current.status !== "ready" && <button disabled={disabled || busy || !!edits || current.errorCode === "REQUEST_UNKNOWN"} onClick={() => void act(async () => { const result = await request<ReferenceAnalysis>(`${base}/${current.id}/resume`, json("POST", { expectedRevision: current.revision })); if (alive.current) accept(result); })}>{say("继续分析（可能产生费用）", "Resume (may incur charges)")}</button>}
          <button disabled={disabled || busy} onClick={() => void act(() => open(current.id))}>{say("重新打开", "Reopen")}</button>
          {!active(current) && <button disabled={disabled || busy || !!edits} onClick={() => void act(async () => { await request(`${base}/${current.id}`, { method: "DELETE" }); if (alive.current) { setCurrent(null); setPreview(null); setFrameId(""); try { localStorage.removeItem(storageKey); } catch {} await load(); } })}>{say("删除分析", "Delete analysis")}</button>}
        </div>
        {current.snapshot.coverage && <p className="mv-hint">{say("已识别文字帧", "Text frames read")} {current.snapshot.frameTexts.length}/{current.snapshot.coverage.ocrFrames} · {say("抽样帧", "Sampled frames")} {current.snapshot.coverage.sampledFrames}</p>}
        <ul className="mv-hint">{(current.snapshot.summary?.limitations ?? current.snapshot.coverage?.limitations ?? []).map((value, i) => <li key={i}>{limitation(value)}</li>)}</ul>
        {!!current.snapshot.texts.length && <section><h4>{say("画面文字", "Screen text")}</h4><div className="mv-choices">
          <button disabled={disabled || busy} onClick={() => void act(async () => { await navigator.clipboard.writeText(current.snapshot.texts.map(t => `[${seconds(t.firstSeenMs)}–${seconds(t.lastSeenMs)}] ${t.text}`).join("\n")); setNotice(["已复制画面文字。", "Screen text copied."]); })}>{say("复制文字", "Copy text")}</button>
          {!edits && <button disabled={disabled || busy || !!active(current)} onClick={() => { setEdits(Object.fromEntries(current.snapshot.texts.map(t => [t.id, t.text]))); setPreview(null); }}>{say("校对文字", "Edit text")}</button>}
          {edits && <><button disabled={disabled || busy} onClick={() => void act(async () => { const result = await request<ReferenceAnalysis>(`${base}/${current.id}/text`, json("PATCH", { expectedRevision: current.revision, texts: Object.entries(edits).map(([id, text]) => ({ id, text })) })); if (alive.current) accept(result, true); })}>{say("保存新修订", "Save revision")}</button><button disabled={disabled || busy} onClick={() => setEdits(null)}>{say("放弃校对", "Discard edits")}</button></>}
        </div>{current.snapshot.texts.map(text => <div key={text.id} className="ma-text"><label><input type="checkbox" checked={selected.includes(text.id)} disabled={disabled || busy || !!edits} onChange={() => choose(text.id)} /> {text.id} · {seconds(text.firstSeenMs)}–{seconds(text.lastSeenMs)}</label>
          {edits ? <textarea aria-label={`${say("校对", "Edit")} ${text.id}`} value={edits[text.id] ?? text.text} maxLength={6000} disabled={disabled || busy} onChange={e => setEdits({ ...edits, [text.id]: e.target.value })} /> : <p>{text.text}</p>}{evidence(text.frameIds)}
          {text.text !== text.rawText && <details><summary>{say("机器原文", "Machine original")}</summary><p>{text.rawText}</p></details>}
        </div>)}</section>}
        {!!current.snapshot.frames.length && !active(current) && !current.snapshot.summary && <button disabled={disabled || busy || !!edits || current.errorCode === "REQUEST_UNKNOWN"} onClick={() => void act(async () => { const result = await request<ReferenceAnalysis>(`${base}/${current.id}/summarize`, json("POST", { expectedRevision: current.revision })); if (alive.current) accept(result); })}>{say("生成当前修订摘要（调用模型）", "Summarize this revision (uses model)")}</button>}
        {current.snapshot.summary && <section><h4>{say("内容摘要与时间线", "Summary and timeline")}</h4><button disabled={disabled || busy} onClick={() => void act(async () => { await navigator.clipboard.writeText(current.snapshot.summary!.summary.map(f => `${f.statement} [${f.evidenceIds.join(", ")}]`).join("\n")); setNotice(["摘要已复制。", "Summary copied."]); })}>{say("复制摘要", "Copy summary")}</button>
          {current.snapshot.summary.summary.map((finding, i) => <div key={i}><p>{finding.statement} {finding.inference && <em>{say("（推断）", "(inference)")}</em>}</p>{evidence(finding.evidenceIds)}</div>)}
          <ol>{current.snapshot.summary.timeline.map((item, i) => <li key={i}><span>{seconds(item.startMs)}–{seconds(item.endMs)} </span>{item.statement}{item.inference && <em>{say("（推断）", "(inference)")}</em>}{evidence(item.evidenceIds)}</li>)}</ol>
          {current.snapshot.summary.marketingPoints.map((item, i) => <p key={i}><strong>{({ hook: say("开头吸引", "Hook"), selling_point: say("卖点", "Selling point"), demonstration: say("展示", "Demonstration"), cta: say("行动号召", "Call to action") })[item.kind]}</strong> · {item.statement}{item.inference && <em>{say("（推断）", "(inference)")}</em>}{evidence(item.evidenceIds)}</p>)}
        </section>}
        {!!current.snapshot.frames.length && <details><summary>{say("选择帧证据", "Select frame evidence")}</summary><div className="ma-frame-list">{current.snapshot.frames.map(frame => <label key={frame.id}><input type="checkbox" checked={selected.includes(frame.id)} disabled={disabled || busy || !!edits} onChange={() => choose(frame.id)} />{evidence([frame.id])} {seconds(frame.ptsMs)}</label>)}</div></details>}
        {frameId && <figure className="ma-frame-preview">{frameUrl ? <img src={frameUrl} alt={`${say("证据帧", "Evidence frame")} ${frameId}`} /> : <p>{say("正在读取证据…", "Loading evidence…")}</p>}<figcaption>{frameId} · {seconds(current.snapshot.frames.find(frame => frame.id === frameId)?.ptsMs ?? 0)}</figcaption></figure>}
        <button disabled={disabled || busy || !canApply || !!active(current) || !!edits || !selected.length} onClick={() => void act(async () => {
          const target = await prepareProject(); const input = { ...target, expectedRevision: current.revision, evidenceIds: selected };
          const result = await request<{ reference: string }>(`${base}/${current.id}/apply-preview`, json("POST", input));
          if (alive.current) setPreview({ text: result.reference, input, analysisId: current.id });
        })}>{say("预览选用到草稿", "Preview use in draft")}</button>
        {preview && <section className="ma-apply-preview"><h4>{say("将替换草稿中的参考文案", "Replace the draft's reference text")}</h4><pre>{preview.text}</pre><button disabled={disabled || busy || !canApply} onClick={() => void act(async () => {
          const target = await prepareProject();
          if (target.projectId !== preview.input.projectId || target.projectVersion !== preview.input.projectVersion) throw new ApiClientError("PROJECT_CONFLICT", 409, "PROJECT_CONFLICT");
          await request(`${base}/${preview.analysisId}/apply`, json("POST", preview.input));
          if (alive.current) { await applied(target.projectId); setPreview(null); setNotice(["已选用为参考文案，可继续拆解改写。", "Saved as reference text. You can now rewrite the copy."]); }
        })}>{say("确认选用", "Confirm use")}</button><button disabled={disabled || busy} onClick={() => setPreview(null)}>{say("关闭预览", "Close preview")}</button></section>}
      </article>}
    </>}
    {error !== null && <p className="mv-error" role="alert">{errorText(error)}</p>}{notice && <p role="status">{say(...notice)}</p>}
  </details>;
}

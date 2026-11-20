import { useEffect, useRef, useState } from "react";
import {
  COMIC_SCRIPT_FILE_BYTES, COMIC_SCRIPT_MAX_CHARS, type ComicClipCheckIssue, type ComicDirectorChatMessage, type ComicDirectorDecision,
  type ComicDirectorInput, type ComicDirectorProposal, type ComicDirectorRoleOutcome, type ComicDirectorState, type ComicDramaDetail,
} from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { comicDirectorApi, comicDirectorError } from "./director-api.js";
import { DirectorGeneration, DirectorRoleChoice, type DirectorRoleChoiceInput } from "./DirectorConfirmations.js";

export function ComicDirectorPanel({ detail, locked, getSaved, apply, applyRole, openClip, onSeriesChanged }: {
  detail: ComicDramaDetail; locked: boolean; getSaved: () => Promise<ComicDramaDetail | null>;
  apply: (proposal: ComicDirectorProposal, decision?: ComicDirectorDecision) => Promise<ComicDirectorProposal | undefined>;
  applyRole: (proposal: ComicDirectorProposal, index: number, input: DirectorRoleChoiceInput) => Promise<ComicDirectorRoleOutcome | undefined>;
  openClip: (id: string) => void;
  onSeriesChanged?: () => void;
}) {
  const { t, locale } = useI18n();
  const [panelTab, setPanelTab] = useState<"chat" | "proposals">("chat");
  const [state, setState] = useState<ComicDirectorState>();
  const [mode, setMode] = useState<ComicDirectorInput["mode"]>("outline");
  const [operation, setOperation] = useState<NonNullable<ComicDirectorInput["action"]>>("script");
  const { id: seriesId, revision } = detail.series;
  const [text, setText] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [checkIssues, setCheckIssues] = useState<ComicClipCheckIssue[] | null>(null);
  const [error, setError] = useState("");
  const [loadingFailed, setLoadingFailed] = useState(false);
  const [fileNote, setFileNote] = useState("");
  const [working, setWorking] = useState<"import" | "write" | "decision" | "chat" | "check" | null>(null);
  const busy = working !== null;
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState("");
  const attempt = useRef<ComicDirectorInput>(null);
  const pending = useRef<AbortController>(null);
  const reload = () => setRefresh(value => value + 1);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await comicDirectorApi.state(seriesId, controller.signal);
        if (controller.signal.aborted) return;
        setState(result); setLoadingFailed(false);
        if (result.proposals.some(proposal => proposal.status === "writing")) timer = setTimeout(poll, 2400);
      } catch { if (!controller.signal.aborted) setLoadingFailed(true); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [seriesId, refresh]);

  const action = async (kind: NonNullable<typeof working>, run: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller; setWorking(kind); setError("");
    try { await run(controller.signal); }
    catch (error) { if (!controller.signal.aborted) setError(comicDirectorError(error)); }
    finally {
      pending.current = null;
      if (!controller.signal.aborted) setWorking(null);
    }
  };
  const importFile = (file: File) => void action("import", async signal => {
    if (!/\.(txt|docx)$/i.test(file.name)) { setError("请选择 TXT 或 DOCX 剧本文件"); return; }
    if (file.size > COMIC_SCRIPT_FILE_BYTES) { setError("剧本文件最大为 2 MB"); return; }
    const result = await comicDirectorApi.import(seriesId, file, signal);
    if (!signal.aborted) {
      setText(result.text);
      setFileNote(result.truncated ? "已截取前 20,000 个字符，请检查内容" : "文件正文已载入");
    }
  });
  const record = (proposal: ComicDirectorProposal) => {
    setState(current => ({ ...current, conversationId: proposal.conversationId,
      proposals: [proposal, ...(current?.proposals.filter(row => row.id !== proposal.id) ?? [])] }));
    setSelected(proposal.id);
    reload();
  };
  const write = () => void action("write", async signal => {
    const expectedRevision = (await getSaved())?.series.revision;
    if (!expectedRevision || !text.trim() || signal.aborted) return;
    const language = locale === "en" || locale === "id" ? locale : "zh";
    const same = attempt.current;
    const replay = same && same.text === text && same.expectedRevision === expectedRevision && same.mode === mode && same.language === language &&
      same.action === operation;
    const fields: ComicDirectorInput = replay ? same : { text, expectedRevision, mode, language, action: operation, requestId: crypto.randomUUID() };
    attempt.current = fields;
    try {
      const result = await comicDirectorApi.propose(seriesId, fields, signal);
      if (signal.aborted) return;
      attempt.current = null;
      record(result);
    } catch (error) {
      if (error instanceof ApiClientError && error.status < 500) attempt.current = null;
      reload();
      throw error;
    }
  });
  const sendChat = (overrideMessage?: string) => void action("chat", async signal => {
    const msg = (overrideMessage ?? chatInput).trim();
    if (!msg) return;
    const savedDetail = await getSaved();
    if (!savedDetail || signal.aborted) return;
    const language = locale === "en" || locale === "id" ? locale : "zh";
    const userMsg: ComicDirectorChatMessage = {
      id: "temp-" + crypto.randomUUID(), role: "user", content: msg, createdAt: new Date().toISOString(),
    };
    setState(cur => cur ? { ...cur, messages: [...(cur.messages ?? []), userMsg] } : cur);
    if (!overrideMessage) setChatInput("");
    const res = await comicDirectorApi.chat(seriesId, { message: msg, expectedRevision: savedDetail.series.revision, language }, signal);
    if (signal.aborted) return;
    setState(cur => ({
      conversationId: res.conversationId,
      proposals: cur?.proposals ?? [],
      quotes: cur?.quotes,
      messages: [...(cur?.messages ?? []).filter(m => m.id !== userMsg.id), { ...userMsg, id: "u-" + res.reply.id }, res.reply],
    }));
    if (res.seriesUpdated) onSeriesChanged?.();
  });
  const runCheck = () => void action("check", async signal => {
    const savedDetail = await getSaved();
    if (!savedDetail || signal.aborted) return;
    const res = await comicDirectorApi.check(seriesId, signal);
    if (!signal.aborted) setCheckIssues(res.issues);
  });
  const decide = (proposal: ComicDirectorProposal, decision: ComicDirectorDecision | "apply" | "dismiss") => void action("decision", async () => {
    if (decision === "dismiss") { record(await comicDirectorApi.dismiss(seriesId, proposal.id)); return; }
    if (!window.confirm(t(decision === "replace" ? "替换全部分镜？已有成片仍可在历史中打开。" :
      decision === "append" ? "追加提案里的分镜？" : decision === "sequel" ? "用这份剧本创建下一集？" : "采用这份剧本，并保存为新版本？"))) return;
    const applied = await apply(proposal, decision === "apply" ? undefined : decision);
    if (applied) record(applied);
  });
  const proposals = state?.proposals ?? [];
  const messages = state?.messages ?? [];
  const shown = proposals.find(item => item.id === selected) ?? proposals[0];
  const writing = proposals.some(item => item.status === "writing");
  return <section className="comic-edit-card comic-director">
    <header>
      <h2>{t("导演助手")}</h2>
      <div className="comic-actions">
        <button type="button" disabled={busy} onClick={runCheck}>{t(working === "check" ? "检查中…" : "整集查漏")}</button>
        <button type="button" onClick={reload}>{t("刷新提案")}</button>
      </div>
    </header>
    <div className="comic-actions comic-director-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={panelTab === "chat"} onClick={() => setPanelTab("chat")}>{t("多轮对话")}</button>
      <button type="button" role="tab" aria-selected={panelTab === "proposals"} onClick={() => setPanelTab("proposals")}>
        {t("剧本与拆分镜提案")}{proposals.length > 0 ? ` (${proposals.length})` : ""}
      </button>
    </div>
    {error && <p role="alert" className="comic-error">{t(error)}</p>}
    {loadingFailed && <p role="alert" className="comic-error">{t("提案暂时无法读取")}</p>}
    {checkIssues !== null && (
      <div className="comic-issue-banner" role="status">
        <div className="comic-actions">
          <strong>{checkIssues.length ? t("整集查漏发现 {0} 项提醒", [checkIssues.length]) : t("整集查漏通过，暂未发现问题")}</strong>
          <button type="button" onClick={() => setCheckIssues(null)}>{t("关闭")}</button>
        </div>
        {checkIssues.length > 0 && <ul>
          {checkIssues.map((issue, idx) => (
            <li key={idx}>
              <button type="button" onClick={() => openClip(issue.clipId)}>{t("分镜 {0}", [issue.clipOrdinal])}</button>
              <span>
                {issue.code === "SPEAKER_NOT_IN_CAST" ? t("说话人「{0}」未在出镜人物中", [issue.speaker])
                  : issue.code === "REFERENCE_LIMIT_EXCEEDED" ? t("参考图 {0}/{1} 张超限", [issue.count, issue.limit])
                    : issue.code === "DIALOGUE_TOO_LONG" ? t("台词约 {0} 秒超出镜头时长", [+(issue.estimatedMs / 1000).toFixed(1)])
                      : t("角色「{0}」造型已更新", [issue.characterName])}
              </span>
            </li>
          ))}
        </ul>}
      </div>
    )}

    {panelTab === "chat" ? (
      <div className="comic-director-chat">
        <div className="comic-actions comic-quick-prompts">
          <button type="button" disabled={busy || locked} onClick={() => sendChat(t("请读取当前剧集并帮我查漏，给出修改建议"))}>
            {t("读全集并查漏")}
          </button>
          <button type="button" disabled={busy || locked} onClick={() => {
            setOperation("breakdown");
            if (!text.trim() && detail.script?.content) { setText(detail.script.content); setMode("paste"); }
            setPanelTab("proposals");
          }}>{t("去拆分镜")}</button>
          <button type="button" disabled={busy || locked} onClick={() => { setOperation("sequel"); setPanelTab("proposals"); }}>
            {t("续写下一集")}
          </button>
        </div>
        <div className="comic-chat-log" aria-live="polite">
          {messages.length === 0 && <p className="comic-generation-note">
            {t("可直接让导演读取整集、修改单个分镜、重排顺序、检索角色或素材库、执行查漏。")}
          </p>}
          {messages.map(msg => (
            <article key={msg.id} className={`comic-chat-bubble ${msg.role}`}>
              <small>{msg.role === "user" ? t("我") : t("漫剧导演")}</small>
              <p>{msg.content}</p>
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <ul className="comic-chat-tools">
                  {msg.toolCalls.map((tool, idx) => (
                    <li key={idx} data-ok={tool.ok}><code>{tool.name}</code> · {tool.summary}</li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
        <form className="comic-chat-form" onSubmit={event => { event.preventDefault(); sendChat(); }}>
          <fieldset disabled={busy || locked}>
            <textarea rows={3} maxLength={4000} value={chatInput} onChange={e => setChatInput(e.target.value)}
              placeholder={t("向导演助手提问或下达分镜调整指令…")} />
            <div className="comic-actions">
              <button type="submit" className="primary" disabled={!chatInput.trim()}>
                {t(working === "chat" ? "导演思考中…" : "发送")}
              </button>
            </div>
          </fieldset>
        </form>
        <DirectorGeneration detail={detail} quotes={state?.quotes ?? []} getSaved={getSaved} disabled={busy || locked} changed={reload} openClip={openClip} />
      </div>
    ) : <>
      <form onSubmit={event => { event.preventDefault(); write(); }}>
        <fieldset disabled={busy || locked || writing}>
          <label>{t("导演任务")}<select aria-label={t("导演任务")} value={operation} onChange={event => {
            const next = event.target.value as typeof operation;
            setOperation(next);
            if (!text.trim() && next !== "script" && detail.script?.content) { setText(detail.script.content); setMode("paste"); }
          }}>
            <option value="script">{t("写剧本")}</option><option value="breakdown">{t("拆分镜")}</option><option value="sequel">{t("续写下一集")}</option>
          </select></label>
          <label>{t("剧本输入方式")}<select value={mode} aria-label={t("剧本输入方式")} onChange={event => {
            setMode(event.target.value as typeof mode); setFileNote("");
          }}>
            <option value="outline">{t("故事梗概")}</option><option value="paste">{t("粘贴原稿")}</option><option value="file">{t("导入 TXT 或 DOCX")}</option>
          </select></label>
          {mode === "file" && <label>{t("上传剧本文件")}<input type="file" accept=".txt,.docx,text/plain"
            onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) importFile(file); }} /></label>}
          {fileNote && <small role="status">{t(fileNote)}</small>}
          <label>{t("导演输入")}<textarea rows={6} value={text} onChange={event => setText(event.target.value)} maxLength={COMIC_SCRIPT_MAX_CHARS}
            required placeholder={t(mode === "outline" ? "写下人物、场景和冲突" : "输入或检查剧本原文")} /></label>
          <div className="comic-actions"><button type="submit" className="primary" disabled={!text.trim()}>
            {t(writing || working === "write" ? "正在生成提案…" : operation === "breakdown" ? "生成拆分镜提案" :
              operation === "sequel" ? "生成续集提案" : "生成剧本提案")}
          </button></div>
        </fieldset>
      </form>
      {proposals.length > 1 && <label>{t("剧本提案记录")}<select value={shown?.id} aria-label={t("剧本提案记录")} onChange={event => setSelected(event.target.value)}>
        {proposals.map(item => <option value={item.id} key={item.id}>{new Date(item.createdAt).toLocaleString(locale)} · {t("基于修订 {0}", [item.baseRevision])}
        </option>)}
      </select></label>}
      {shown && <ProposalCard key={shown.id} proposal={shown} busy={busy || locked} stale={shown.baseRevision !== revision}
        decide={decision => decide(shown, decision)} role={(index, input) => void action("decision", async () => {
          const outcome = await applyRole(shown, index, input);
          if (outcome) record({ ...shown, roleDecisions: { ...shown.roleDecisions, [index]: outcome } });
        })} />}
      <DirectorGeneration detail={detail} quotes={state?.quotes ?? []} getSaved={getSaved} disabled={busy || locked} changed={reload} openClip={openClip} />
    </>}
  </section>;
}

function ProposalCard({ proposal, busy, stale, decide, role: chooseRole }: {
  proposal: ComicDirectorProposal; busy: boolean; stale: boolean; decide: (action: ComicDirectorDecision | "apply" | "dismiss") => void;
  role: (index: number, input: DirectorRoleChoiceInput) => void;
}) {
  const { t } = useI18n();
  const status = { writing: "正在写剧本…", unknown: "提案结果待核实，请刷新记录", failed: "未生成可用剧本，请检查模型账号或输入",
    ready: "待审核", applied: proposal.decision === "sequel" ? "已创建续集" : proposal.decision ? "已应用分镜" : "已采用剧本", dismissed: "已放弃提案" };
  const clips = proposal.proposal?.clips;
  return <article className="comic-director-proposal">
    <header><h3>{t(proposal.input.action === "breakdown" ? "拆分镜提案" : proposal.input.action === "sequel" ? "续集提案" : "剧本提案")}</h3>
      <span role="status">{t(status[proposal.status])}</span></header>
    <small>{t("基于修订 {0}", [proposal.baseRevision])}</small>
    {proposal.proposal && <>
      <details><summary>{t("查看本次输入")}</summary><pre>{proposal.input.text}</pre></details>
      {clips ? <div className="comic-script-compare">
        <section><h4>{t("提交时的分镜")}</h4><ol>{proposal.proposal.previousScenes?.map((scene, index) =>
          <li key={index}>{scene || t("未命名分镜")}</li>)}</ol></section>
        <section><h4>{t("建议分镜")}</h4><ol>{clips.map((clip, index) => <li key={index}>
          <strong>{clip.scene}</strong> · {t("{0} 秒", [clip.durationMs / 1000])}
          <ul>{clip.shots.map(shot => <li key={shot.id}>{shot.description}</li>)}</ul>
          <ul>{clip.lines.map(line => <li key={line.id}>{line.speaker ? `${line.speaker} · ` : ""}{line.text}</li>)}</ul>
        </li>)}</ol></section>
      </div> : <div className="comic-script-compare">
        <section><h4>{t("提交时的剧本")}</h4><pre>{proposal.original || t("提交时暂无剧本")}</pre></section>
        <section><h4>{t("建议剧本")}</h4><pre>{proposal.proposal.script}</pre></section>
      </div>}
      {proposal.proposal.roles.length > 0 && <section><h4>{t("角色匹配建议")}</h4><ul>
        {proposal.proposal.roles.map((role, index) => <li key={role.name + index}>
          <strong>{role.name}</strong><p>{role.description}</p>
          <small>{t(role.candidates.length > 1 ? "有多个同名或别名候选" : role.candidates.length ? "匹配到本人角色库" : "角色库暂无匹配")}</small>
          {role.candidates.length > 0 && <p>{role.candidates.map(candidate => candidate.name).join(" · ")}</p>}
          {proposal.status === "applied" && <DirectorRoleChoice role={role} disabled={busy}
            outcome={proposal.roleDecisions?.[index]} submit={input => chooseRole(index, input)} />}
        </li>)}
      </ul></section>}
      {proposal.status === "ready" && <div className="comic-actions">
        {clips ? <>
          <button type="button" className="primary" disabled={busy || stale} onClick={() => decide("append")}>{t("只追加分镜")}</button>
          <button type="button" disabled={busy || stale} onClick={() => decide("replace")}>{t("替换全部分镜")}</button>
        </> : proposal.input.action === "sequel"
          ? <button type="button" className="primary" disabled={busy || stale} onClick={() => decide("sequel")}>{t("创建下一集")}</button>
          : <button type="button" className="primary" disabled={busy || stale} onClick={() => decide("apply")}>{t("采用剧本")}</button>}
        <button type="button" disabled={busy} onClick={() => decide("dismiss")}>{t("放弃提案")}</button>
        {stale && <small>{t("剧集已更新，请基于最新修订生成提案")}</small>}
      </div>}
    </>}
  </article>;
}

import { useEffect, useRef, useState } from "react";
import {
  COMIC_SCRIPT_FILE_BYTES, COMIC_SCRIPT_MAX_CHARS, type ComicDirectorDecision, type ComicDirectorInput, type ComicDirectorProposal,
  type ComicDirectorRoleOutcome, type ComicDirectorState, type ComicDramaDetail,
} from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { comicDirectorApi, comicDirectorError } from "./director-api.js";
import { DirectorGeneration, DirectorRoleChoice, type DirectorRoleChoiceInput } from "./DirectorConfirmations.js";

export function ComicDirectorPanel({ detail, locked, getSaved, apply, applyRole, openClip }: {
  detail: ComicDramaDetail; locked: boolean; getSaved: () => Promise<ComicDramaDetail | null>;
  apply: (proposal: ComicDirectorProposal, decision?: ComicDirectorDecision) => Promise<ComicDirectorProposal | undefined>;
  applyRole: (proposal: ComicDirectorProposal, index: number, input: DirectorRoleChoiceInput) => Promise<ComicDirectorRoleOutcome | undefined>;
  openClip: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<ComicDirectorState>();
  const [mode, setMode] = useState<ComicDirectorInput["mode"]>("outline");
  const [operation, setOperation] = useState<NonNullable<ComicDirectorInput["action"]>>("script");
  const { id: seriesId, revision } = detail.series;
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loadingFailed, setLoadingFailed] = useState(false);
  const [fileNote, setFileNote] = useState("");
  const [working, setWorking] = useState<"import" | "write" | "decision" | null>(null);
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
  const decide = (proposal: ComicDirectorProposal, decision: ComicDirectorDecision | "apply" | "dismiss") => void action("decision", async () => {
    if (decision === "dismiss") { record(await comicDirectorApi.dismiss(seriesId, proposal.id)); return; }
    if (!window.confirm(t(decision === "replace" ? "替换全部分镜？已有成片仍可在历史中打开。" :
      decision === "append" ? "追加提案里的分镜？" : decision === "sequel" ? "用这份剧本创建下一集？" : "采用这份剧本，并保存为新版本？"))) return;
    const applied = await apply(proposal, decision === "apply" ? undefined : decision);
    if (applied) record(applied);
  });
  const proposals = state?.proposals ?? [];
  const shown = proposals.find(item => item.id === selected) ?? proposals[0];
  const writing = proposals.some(item => item.status === "writing");
  return <section className="comic-edit-card comic-director">
    <header><h2>{t("导演助手")}</h2><button type="button" onClick={reload}>{t("刷新提案")}</button></header>
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
    {error && <p role="alert" className="comic-error">{t(error)}</p>}
    {loadingFailed && <p role="alert" className="comic-error">{t("提案暂时无法读取")}</p>}
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
          {proposal.status === "applied" && !proposal.sequelId && <DirectorRoleChoice role={role} disabled={busy}
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

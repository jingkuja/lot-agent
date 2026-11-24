import { useEffect, useState } from "react";
import {
  COMIC_SCRIPT_MAX_CHARS, normalizeShotDurationShares, rebalanceShotDurationShares, splitComicScriptSegments,
  type ComicClipEnhancementSegment, type ComicDictionaryEntry, type ComicDirectorApplyInput, type ComicDirectorEnhanceTarget,
  type ComicDirectorProposal, type ComicDramaClipDraft, type ComicDramaDetail, type ComicScriptEnhancementSegment,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { DictionaryOptions, useComicChoices } from "./LibraryParts.js";

export type DirectorEnhanceIntent = {
  token: number;
  target:
    | { scope: "script_full" }
    | { scope: "script_excerpt"; ranges?: Array<{ start: number; end: number }> }
    | { scope: "clips"; clipIds: string[] };
};

function labelOf(choices: readonly ComicDictionaryEntry[], key: string | null | undefined, locale: "zh" | "en" | "id") {
  if (!key) return "—";
  return choices.find(entry => entry.key === key)?.labels[locale] ?? key;
}

function isClipDraftValid(draft: ComicDramaClipDraft) {
  return draft.durationMs >= 1000 && draft.durationMs <= 60_000
    && draft.shots.length >= 1 && draft.shots.length <= 3
    && draft.shots.every(shot => shot.description.trim().length > 0 && shot.durationShare >= 1)
    && draft.shots.reduce((sum, shot) => sum + shot.durationShare, 0) === 100
    && draft.lines.every(line => line.text.trim().length > 0);
}

export function ComicEnhanceForm({
  detail, selectedClipId, intent, onIntentConsumed, busy, locked, writing, onSubmit,
}: {
  detail: ComicDramaDetail;
  selectedClipId?: string | null;
  intent?: DirectorEnhanceIntent | null;
  onIntentConsumed?: () => void;
  busy: boolean;
  locked: boolean;
  writing: boolean;
  onSubmit: (target: ComicDirectorEnhanceTarget, instruction: string) => void;
}) {
  const { t } = useI18n();
  const scriptContent = detail.script?.content ?? "";
  const scriptSegments = splitComicScriptSegments(scriptContent, 24);
  const [scope, setScope] = useState<ComicDirectorEnhanceTarget["scope"]>(
    selectedClipId && detail.clips.length ? "clips" : "script_full",
  );
  const [excerptRanges, setExcerptRanges] = useState<Array<{ start: number; end: number }>>([]);
  const [selectedParagraphs, setSelectedParagraphs] = useState<number[]>(() => scriptSegments.length ? [0] : []);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>(() => {
    const initial = selectedClipId && detail.clips.some(c => c.id === selectedClipId)
      ? selectedClipId
      : detail.clips[0]?.id;
    return initial ? [initial] : [];
  });
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    if (!intent) return;
    setScope(intent.target.scope);
    if (intent.target.scope === "script_excerpt") {
      if (intent.target.ranges?.length) {
        setExcerptRanges(intent.target.ranges);
      } else {
        setExcerptRanges([]);
        setSelectedParagraphs(scriptSegments.length ? [0] : []);
      }
    } else if (intent.target.scope === "clips") {
      setSelectedClipIds(intent.target.clipIds);
    }
    onIntentConsumed?.();
  }, [intent, onIntentConsumed]);

  const validClipIds = detail.clips.filter(c => selectedClipIds.includes(c.id)).map(c => c.id);
  const resolvedRanges = excerptRanges.length
    ? excerptRanges
    : selectedParagraphs
      .map(index => scriptSegments[index])
      .filter((seg): seg is NonNullable<typeof seg> => Boolean(seg))
      .map(seg => ({ start: seg.start, end: seg.end }));

  const canSubmit = scope === "script_full"
    ? scriptContent.trim().length > 0
    : scope === "script_excerpt"
      ? scriptContent.trim().length > 0 && resolvedRanges.length > 0
      : validClipIds.length > 0;

  const toggleParagraph = (index: number) => {
    setExcerptRanges([]);
    setSelectedParagraphs(cur => cur.includes(index)
      ? cur.filter(item => item !== index)
      : cur.length < 24 ? [...cur, index].sort((a, b) => a - b) : cur);
  };
  const toggleClip = (clipId: string) => {
    setSelectedClipIds(cur => cur.includes(clipId)
      ? cur.filter(item => item !== clipId)
      : cur.length < 24 ? [...cur, clipId] : cur);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const target: ComicDirectorEnhanceTarget = scope === "script_full"
      ? { scope: "script_full" }
      : scope === "script_excerpt"
        ? { scope: "script_excerpt", ranges: resolvedRanges }
        : { scope: "clips", clipIds: validClipIds };
    onSubmit(target, instruction.trim());
  };

  return (
    <form onSubmit={handleSubmit}>
      <fieldset disabled={busy || locked || writing}>
        <label>{t("增强范围")}
          <select aria-label={t("增强范围")} value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
            <option value="script_full">{t("整篇剧本")}</option>
            <option value="script_excerpt">{t("一段原文")}</option>
            <option value="clips">{t("分镜卡")}</option>
          </select>
        </label>

        {scope === "script_full" && (
          scriptSegments.length > 0
            ? <small>{t("将逐段增强全本共 {0} 段内容，并保留原稿供逐段审核采用。", [scriptSegments.length])}</small>
            : <small>{t("当前剧集暂无剧本内容，请先编写或生成剧本")}</small>
        )}

        {scope === "script_excerpt" && (
          scriptSegments.length === 0 ? (
            <small>{t("当前剧集暂无剧本内容，请先编写或生成剧本")}</small>
          ) : excerptRanges.length > 0 ? (
            <div className="comic-enhance-selection">
              <div className="comic-actions">
                <strong>{t("已选原文片段（{0} 处）", [excerptRanges.length])}</strong>
                <button type="button" onClick={() => setExcerptRanges([])}>{t("改选段落")}</button>
              </div>
              {excerptRanges.map((range, idx) => (
                <pre key={idx} className="comic-enhance-excerpt-preview">{scriptContent.slice(range.start, range.end)}</pre>
              ))}
            </div>
          ) : (
            <div className="comic-ref-checklist" role="group" aria-label={t("选择剧本段落")}>
              {scriptSegments.map(seg => (
                <label key={seg.index} className="comic-video-replace">
                  <input type="checkbox" checked={selectedParagraphs.includes(seg.index)} onChange={() => toggleParagraph(seg.index)} />
                  <span>{t("第 {0} 段", [seg.index + 1])} · {seg.original.slice(0, 48)}{seg.original.length > 48 ? "…" : ""}</span>
                </label>
              ))}
            </div>
          )
        )}

        {scope === "clips" && (
          detail.clips.length === 0 ? (
            <small>{t("当前剧集暂无分镜，请先添加或拆分分镜。")}</small>
          ) : (
            <div className="comic-ref-checklist" role="group" aria-label={t("选择增强分镜")}>
              {detail.clips.map(clip => (
                <label key={clip.id} className="comic-video-replace">
                  <input type="checkbox" checked={validClipIds.includes(clip.id)} onChange={() => toggleClip(clip.id)} />
                  <span>{t("分镜 {0}", [clip.ordinal])}{clip.draft.scene ? ` · ${clip.draft.scene}` : ""}</span>
                </label>
              ))}
            </div>
          )
        )}

        <label>{t("增强要求（可选）")}
          <textarea rows={3} maxLength={4000} value={instruction} onChange={event => setInstruction(event.target.value)}
            placeholder={t(scope === "clips"
              ? "例如：强化镜头推进和动作细节，让对白更符合人物性格…"
              : "例如：增强情节转折与人物动作描写，压缩冗余对白…")} />
        </label>
        <div className="comic-actions">
          <button type="submit" className="primary" disabled={!canSubmit}>
            {t(writing || busy ? "正在生成增强建议…" : "生成 AI 增强建议")}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

export function EnhanceProposalCard({
  proposal, detail, currentRevision, busy, locked, onApply, onDismiss, onRegenerate,
}: {
  proposal: ComicDirectorProposal;
  detail: ComicDramaDetail;
  currentRevision: number;
  busy: boolean;
  locked: boolean;
  onApply: (input: Omit<ComicDirectorApplyInput, "expectedRevision">) => void;
  onDismiss: (itemIndex?: number) => void;
  onRegenerate?: () => void;
}) {
  const { t, locale } = useI18n();
  const framing = useComicChoices("framing");
  const movement = useComicChoices("movement");
  const emotions = useComicChoices("emotion");
  const [scriptDrafts, setScriptDrafts] = useState<Record<number, string>>({});
  const [clipDrafts, setClipDrafts] = useState<Record<number, ComicDramaClipDraft>>({});

  const scriptSegs = proposal.proposal?.scriptEnhancements;
  const clipSegs = proposal.proposal?.clipEnhancements;
  const isClip = proposal.input.enhance?.scope === "clips" || !!clipSegs?.length;
  const activeRevision = proposal.appliedRevision ?? proposal.baseRevision;
  const stale = proposal.status === "ready" && activeRevision !== currentRevision;

  const allItems = scriptSegs ?? clipSegs ?? [];
  const pendingItems = allItems.filter(item => item.status === "pending");
  const appliedCount = allItems.filter(item => item.status === "applied").length;

  const statusLabel = proposal.status === "writing" ? "正在生成增强建议…"
    : proposal.status === "unknown" ? "提案结果待核实，请刷新记录"
      : proposal.status === "failed" ? "未生成可用增强建议，请检查模型账号或输入"
        : proposal.status === "applied" ? "已采用建议"
          : proposal.status === "dismissed" ? "已舍弃建议"
            : appliedCount > 0 ? "部分已采用" : "待审核";

  const getScriptText = (seg: ComicScriptEnhancementSegment) =>
    scriptDrafts[seg.index] ?? seg.appliedText ?? seg.suggested;

  const getClipDraft = (seg: ComicClipEnhancementSegment) =>
    clipDrafts[seg.index] ?? seg.appliedDraft ?? seg.suggested;

  const canApplyAll = pendingItems.length > 0 && !stale && !busy && !locked && (
    scriptSegs
      ? (scriptSegs.filter(s => s.status === "pending").every(s => getScriptText(s).trim().length > 0))
      : (clipSegs?.filter(s => s.status === "pending").every(s => isClipDraftValid(getClipDraft(s))) ?? false)
  );

  const applyAll = () => {
    if (!canApplyAll) return;
    if (scriptSegs) {
      onApply({
        decision: "enhance",
        scriptItems: scriptSegs.filter(s => s.status === "pending").map(s => ({ index: s.index, text: getScriptText(s) })),
      });
    } else if (clipSegs) {
      onApply({
        decision: "enhance",
        clipItems: clipSegs.filter(s => s.status === "pending").map(s => ({ index: s.index, draft: getClipDraft(s) })),
      });
    }
  };

  const firstFraming = framing.find(entry => !entry.inactive)?.key ?? "medium";
  const firstMovement = movement.find(entry => !entry.inactive)?.key ?? "fixed";
  const castNames = detail.cast.map(entry => entry.snapshot.name);

  return (
    <article className="comic-director-proposal comic-enhance-proposal">
      <header>
        <h3>{t(isClip ? "分镜增强建议" : "剧本增强建议")}</h3>
        <span role="status">{t(statusLabel)}</span>
      </header>
      <small>{t("基于修订 {0}", [activeRevision])}</small>
      {proposal.input.text && (
        <details><summary>{t("查看本次要求")}</summary><pre>{proposal.input.text}</pre></details>
      )}

      {stale && (
        <div className="comic-issue-banner" role="alert">
          <strong>{t("原稿已更新，请重新核对")}</strong>
          <p>{t("建议生成或待审期间原稿已修改，为避免覆盖最新内容，请基于最新草稿重新生成建议。")}</p>
          {onRegenerate && !locked && (
            <div className="comic-actions">
              <button type="button" disabled={busy} onClick={onRegenerate}>{t("基于最新草稿重新生成")}</button>
            </div>
          )}
        </div>
      )}

      {scriptSegs?.map(seg => {
        const draftText = getScriptText(seg);
        const segStatus = seg.status === "applied" ? "已采用" : seg.status === "dismissed" ? "已舍弃" : "待审核";
        return (
          <div key={seg.index} className="comic-enhance-segment" data-status={seg.status}>
            <div className="comic-enhance-segment-head">
              <strong>{t("第 {0} 段", [seg.index + 1])}</strong>
              <small className="comic-pill" data-tone={seg.status === "applied" ? "done" : seg.status === "dismissed" ? "idle" : "frame"}>
                {t(segStatus)}
              </small>
            </div>
            {seg.notes && <small className="comic-enhance-note">{seg.notes}</small>}
            <div className="comic-script-compare">
              <section>
                <h4>{t("原稿")}</h4>
                <pre>{seg.original}</pre>
              </section>
              <section>
                <h4>{t("建议")}</h4>
                {seg.status === "pending" && !locked ? (
                  <textarea
                    aria-label={t("第 {0} 段增强建议", [seg.index + 1])}
                    rows={5}
                    maxLength={COMIC_SCRIPT_MAX_CHARS}
                    value={draftText}
                    disabled={busy || stale}
                    onChange={event => setScriptDrafts(cur => ({ ...cur, [seg.index]: event.target.value }))}
                  />
                ) : (
                  <pre>{seg.appliedText ?? seg.suggested}</pre>
                )}
              </section>
            </div>
            {seg.status === "pending" && proposal.status === "ready" && (
              <div className="comic-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy || locked || stale || !draftText.trim()}
                  onClick={() => onApply({ decision: "enhance", scriptItems: [{ index: seg.index, text: draftText }] })}
                >
                  {t("采用本段")}
                </button>
                <button type="button" disabled={busy || locked} onClick={() => onDismiss(seg.index)}>
                  {t("舍弃本段")}
                </button>
                {draftText !== seg.suggested && (
                  <button
                    type="button"
                    disabled={busy || locked}
                    onClick={() => setScriptDrafts(cur => {
                      const next = { ...cur };
                      delete next[seg.index];
                      return next;
                    })}
                  >
                    {t("恢复建议")}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {clipSegs?.map(seg => {
        const draft = getClipDraft(seg);
        const segStatus = seg.status === "applied" ? "已采用" : seg.status === "dismissed" ? "已舍弃" : "待审核";
        const setDraft = (next: ComicDramaClipDraft) => setClipDrafts(cur => ({ ...cur, [seg.index]: next }));
        const updateShot = (shotIdx: number, patch: Partial<ComicDramaClipDraft["shots"][number]>) =>
          setDraft({ ...draft, shots: draft.shots.map((shot, i) => i === shotIdx ? { ...shot, ...patch } : shot) });
        const setShots = (nextShots: ComicDramaClipDraft["shots"]) => {
          if (!nextShots.length) return;
          const shares = normalizeShotDurationShares(nextShots.map(shot => shot.durationShare));
          setDraft({ ...draft, shots: nextShots.map((shot, i) => ({ ...shot, durationShare: shares[i]! })) });
        };
        const updateLine = (lineIdx: number, patch: Partial<ComicDramaClipDraft["lines"][number]>) =>
          setDraft({ ...draft, lines: draft.lines.map((line, i) => i === lineIdx ? { ...line, ...patch } : line) });
        const modified = JSON.stringify(draft) !== JSON.stringify(seg.suggested);

        return (
          <div key={seg.clipId} className="comic-enhance-segment" data-status={seg.status}>
            <div className="comic-enhance-segment-head">
              <strong>{t("分镜 {0}", [seg.ordinal])}</strong>
              <small className="comic-pill" data-tone={seg.status === "applied" ? "done" : seg.status === "dismissed" ? "idle" : "frame"}>
                {t(segStatus)}
              </small>
            </div>
            {seg.notes && <small className="comic-enhance-note">{seg.notes}</small>}
            <div className="comic-script-compare">
              <section>
                <h4>{t("原稿")}</h4>
                <p><strong>{seg.original.scene || t("未命名分镜")}</strong> · {t("{0} 秒", [seg.original.durationMs / 1000])}</p>
                <ul>
                  {seg.original.shots.map(shot => (
                    <li key={shot.id}>
                      [{labelOf(framing, shot.framingKey, locale)} · {labelOf(movement, shot.movementKey, locale)} · {shot.durationShare}%]{" "}
                      {shot.description || "—"}
                    </li>
                  ))}
                </ul>
                {seg.original.lines.length > 0 && (
                  <ul>
                    {seg.original.lines.map(line => (
                      <li key={line.id}>
                        {line.speaker || t("旁白")}
                        {line.emotionKey ? ` (${labelOf(emotions, line.emotionKey, locale)})` : ""} · {line.text}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h4>{t("建议")}</h4>
                {seg.status === "pending" && !locked ? (
                  <fieldset className="comic-enhance-clip-editor" disabled={busy || stale}>
                    <div className="comic-fields">
                      <label>{t("场景")}
                        <input maxLength={1000} value={draft.scene} onChange={e => setDraft({ ...draft, scene: e.target.value })} />
                      </label>
                      <label>{t("时长（秒）")}
                        <input type="number" min={1} max={60} step={1} value={Math.round(draft.durationMs / 1000)}
                          onChange={e => {
                            const ms = Math.round(e.currentTarget.valueAsNumber * 1000);
                            if (Number.isFinite(ms) && ms >= 1000 && ms <= 60_000) setDraft({ ...draft, durationMs: ms });
                          }} />
                      </label>
                    </div>
                    <div className="comic-section-heading">
                      <strong>{t("镜头")}</strong>
                      <button type="button" disabled={draft.shots.length >= 3} onClick={() => setShots([
                        ...draft.shots,
                        { id: crypto.randomUUID(), framingKey: firstFraming, movementKey: firstMovement, description: "", durationShare: 50 },
                      ])}>＋ {t("添加镜头")}</button>
                    </div>
                    {draft.shots.map((shot, shotIdx) => (
                      <div key={shot.id} className="comic-enhance-subrow">
                        <div className="comic-actions">
                          <label>{t("景别")}
                            <DictionaryOptions aria-label={t("分镜 {0} 镜头 {1} 景别", [seg.ordinal, shotIdx + 1])}
                              choices={framing} value={shot.framingKey} existing={shot.framingKey}
                              onChange={e => updateShot(shotIdx, { framingKey: e.target.value })} />
                          </label>
                          <label>{t("运镜")}
                            <DictionaryOptions aria-label={t("分镜 {0} 镜头 {1} 运镜", [seg.ordinal, shotIdx + 1])}
                              choices={movement} value={shot.movementKey} existing={shot.movementKey}
                              onChange={e => updateShot(shotIdx, { movementKey: e.target.value })} />
                          </label>
                          <label className="comic-share-field">{t("时长占比（%）")}
                            <input type="number" aria-label={t("分镜 {0} 镜头 {1} 时长占比", [seg.ordinal, shotIdx + 1])}
                              min={1} max={100} value={shot.durationShare} disabled={draft.shots.length <= 1}
                              onChange={e => {
                                const val = e.currentTarget.valueAsNumber;
                                if (Number.isFinite(val)) setDraft({ ...draft, shots: rebalanceShotDurationShares(draft.shots, shotIdx, val) });
                              }} />
                          </label>
                          <button type="button" disabled={draft.shots.length <= 1}
                            onClick={() => setShots(draft.shots.filter(item => item.id !== shot.id))}>
                            {t("删除镜头")}
                          </button>
                        </div>
                        <label>{t("镜头描述")}
                          <textarea aria-label={t("分镜 {0} 镜头 {1} 描述", [seg.ordinal, shotIdx + 1])}
                            rows={2} maxLength={2000} value={shot.description}
                            onChange={e => updateShot(shotIdx, { description: e.target.value })} />
                        </label>
                      </div>
                    ))}
                    <div className="comic-section-heading">
                      <strong>{t("台词")}</strong>
                      <button type="button" disabled={draft.lines.length >= 30} onClick={() => setDraft({
                        ...draft,
                        lines: [...draft.lines, { id: crypto.randomUUID(), speaker: null, text: "", emotionKey: null, speed: 1 }],
                      })}>＋ {t("添加台词")}</button>
                    </div>
                    {draft.lines.map((line, lineIdx) => {
                      const isCastSpeaker = !!line.speaker && castNames.includes(line.speaker);
                      const selectVal = !line.speaker ? "__narrator__" : isCastSpeaker ? line.speaker : "__custom__";
                      return (
                        <div key={line.id} className="comic-enhance-subrow">
                          <div className="comic-actions">
                            <label>{t("说话人")}
                              <select aria-label={t("分镜 {0} 台词 {1} 说话人", [seg.ordinal, lineIdx + 1])} value={selectVal}
                                onChange={e => {
                                  const val = e.target.value;
                                  if (val === "__narrator__") updateLine(lineIdx, { speaker: null });
                                  else if (val === "__custom__") {
                                    updateLine(lineIdx, { speaker: isCastSpeaker || !line.speaker ? t("自定义角色") : line.speaker });
                                  } else updateLine(lineIdx, { speaker: val });
                                }}>
                                <option value="__narrator__">{t("旁白")}</option>
                                {detail.cast.map(({ snapshot }) => (
                                  <option key={snapshot.characterId} value={snapshot.name}>{snapshot.name}</option>
                                ))}
                                <option value="__custom__">{t("自定义说话人")}</option>
                              </select>
                            </label>
                            {selectVal === "__custom__" && (
                              <label>{t("说话人名称")}
                                <input maxLength={120} value={line.speaker ?? ""}
                                  onChange={e => updateLine(lineIdx, { speaker: e.target.value || null })} />
                              </label>
                            )}
                            <label>{t("情绪")}
                              <DictionaryOptions choices={emotions} value={line.emotionKey ?? ""} existing={line.emotionKey} empty="—"
                                onChange={e => updateLine(lineIdx, { emotionKey: e.target.value || null })} />
                            </label>
                            <label>{t("语速")}
                              <select value={line.speed} onChange={e => updateLine(lineIdx, { speed: Number(e.target.value) })}>
                                {[0.5, 0.75, 1, 1.25, 1.5, 2].map(speed => <option key={speed} value={speed}>{speed}×</option>)}
                              </select>
                            </label>
                            <button type="button" onClick={() => setDraft({
                              ...draft, lines: draft.lines.filter(item => item.id !== line.id),
                            })}>{t("删除台词")}</button>
                          </div>
                          <label>{t("台词文本")}
                            <textarea aria-label={t("分镜 {0} 台词 {1} 内容", [seg.ordinal, lineIdx + 1])}
                              rows={2} maxLength={1000} value={line.text}
                              onChange={e => updateLine(lineIdx, { text: e.target.value })} />
                          </label>
                        </div>
                      );
                    })}
                  </fieldset>
                ) : (
                  <>
                    {(() => {
                      const shownDraft = seg.appliedDraft ?? seg.suggested;
                      return (
                        <>
                          <p><strong>{shownDraft.scene || t("未命名分镜")}</strong> · {t("{0} 秒", [shownDraft.durationMs / 1000])}</p>
                          <ul>
                            {shownDraft.shots.map(shot => (
                              <li key={shot.id}>
                                [{labelOf(framing, shot.framingKey, locale)} · {labelOf(movement, shot.movementKey, locale)} · {shot.durationShare}%]{" "}
                                {shot.description || "—"}
                              </li>
                            ))}
                          </ul>
                          {shownDraft.lines.length > 0 && (
                            <ul>
                              {shownDraft.lines.map(line => (
                                <li key={line.id}>
                                  {line.speaker || t("旁白")}
                                  {line.emotionKey ? ` (${labelOf(emotions, line.emotionKey, locale)})` : ""} · {line.text}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      );
                    })()}
                  </>
                )}
              </section>
            </div>
            {seg.status === "pending" && proposal.status === "ready" && (
              <div className="comic-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy || locked || stale || !isClipDraftValid(draft)}
                  onClick={() => onApply({ decision: "enhance", clipItems: [{ index: seg.index, draft }] })}
                >
                  {t("采用本段")}
                </button>
                <button type="button" disabled={busy || locked} onClick={() => onDismiss(seg.index)}>
                  {t("舍弃本段")}
                </button>
                {modified && (
                  <button
                    type="button"
                    disabled={busy || locked}
                    onClick={() => setClipDrafts(cur => {
                      const next = { ...cur };
                      delete next[seg.index];
                      return next;
                    })}
                  >
                    {t("恢复建议")}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {proposal.status === "ready" && pendingItems.length > 0 && (
        <div className="comic-actions comic-enhance-footer">
          {pendingItems.length > 1 && (
            <button type="button" className="primary" disabled={!canApplyAll} onClick={applyAll}>
              {t("全部采用")}
            </button>
          )}
          <button type="button" disabled={busy || locked} onClick={() => onDismiss()}>
            {t("放弃提案")}
          </button>
        </div>
      )}
    </article>
  );
}

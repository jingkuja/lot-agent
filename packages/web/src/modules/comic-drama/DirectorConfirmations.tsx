import { comicVideoProfile } from "@lot-agent/core/comic-drama";
import { useEffect, useState } from "react";
import type {
  ComicDirectorRole, ComicDirectorRoleDecision, ComicDirectorRoleOutcome, ComicDirectorQuote, ComicDramaDetail, ComicGenerationMode,
  ComicGenerationQuote, ComicOutfit,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicDirectorApi, comicDirectorError } from "./director-api.js";
import { computeComicBatchPlan } from "./batch-plan.js";
import { comicLibraryApi } from "./library-api.js";
import { comicGenerationApi } from "./generation-api.js";
import { GenerationQuoteDialog } from "./GenerationQuoteDialog.js";

export type DirectorRoleChoiceInput = Omit<Extract<ComicDirectorRoleDecision, { choice: "existing" }>, "expectedRevision">
  | Omit<Extract<ComicDirectorRoleDecision, { choice: "new" }>, "expectedRevision"> | { choice: "skip" };
export function DirectorRoleChoice({ role, outcome, disabled, submit }: {
  role: ComicDirectorRole; outcome?: ComicDirectorRoleOutcome; disabled: boolean; submit: (input: DirectorRoleChoiceInput) => void;
}) {
  const { t } = useI18n();
  const [characterId, setCharacter] = useState("");
  const [outfitId, setOutfit] = useState("");
  const [outfits, setOutfits] = useState<ComicOutfit[]>([]);
  const [failed, setFailed] = useState(false);
  const [outfitName, setOutfitName] = useState("");
  useEffect(() => {
    setOutfit(""); setOutfits([]); setFailed(false);
    if (!characterId) return;
    const controller = new AbortController();
    void comicLibraryApi.character(characterId, controller.signal).then(result => {
      if (!controller.signal.aborted) setOutfits(result.outfits);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [characterId]);
  if (outcome) return <small role="status">{t(outcome.choice === "skip" ? "已跳过角色" : "已确认角色")}</small>;
  return <fieldset disabled={disabled}>
    {!!role.candidates.length && <>
      <select aria-label={t("选择角色候选")} value={characterId} onChange={event => setCharacter(event.target.value)}>
        <option value="">{t("选择角色候选")}</option>
        {role.candidates.map(candidate => {
          const sameName = role.candidates.some(other => other.id !== candidate.id && other.name === candidate.name);
          const label = [candidate.name, candidate.appearance, sameName ? candidate.id.slice(0, 8) : ""].filter(Boolean).join(" · ");
          return <option key={candidate.id} value={candidate.id}>{label}</option>;
        })}
      </select>
      {characterId && <select aria-label={t("选择造型")} value={outfitId} onChange={event => setOutfit(event.target.value)}>
        <option value="">{t("选择造型")}</option>
        {outfits.map(outfit => <option key={outfit.id} value={outfit.id}>{outfit.name}</option>)}
      </select>}
      {failed && <p role="alert">{t("操作失败，请重试")}</p>}
      <button type="button" disabled={!outfitId} onClick={() => submit({ choice: "existing", characterId, outfitId })}>{t("确认选角")}</button>
    </>}
    <label>{t("新角色造型名称")}<input maxLength={120} value={outfitName} onChange={event => setOutfitName(event.target.value)} /></label>
    <div className="comic-actions">
      <button type="button" disabled={!outfitName.trim()} onClick={() => {
        if (window.confirm(t("创建并选用这个角色？"))) submit({ choice: "new", outfitName });
      }}>{t("新建并选用角色")}</button>
      <button type="button" onClick={() => submit({ choice: "skip" })}>{t("跳过角色")}</button>
    </div>
  </fieldset>;
}

export function DirectorGeneration({ detail, quotes, getSaved, disabled, changed, openClip, editClip }: {
  detail: ComicDramaDetail; quotes: ComicDirectorQuote[]; getSaved: () => Promise<ComicDramaDetail | null>; disabled: boolean;
  changed: () => void; openClip: (id: string) => void; editClip: (id: string) => void;
}) {
  const { t } = useI18n();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<ComicGenerationMode>("keyframe");
  const [quote, setQuote] = useState<ComicGenerationQuote>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const labels = (id: string) => {
    const target = detail.clips.find(clip => clip.id === id);
    return target ? `${t("分镜 {0}", [target.ordinal])}${target.draft.scene ? " · " + target.draft.scene : ""}` : t("分镜");
  };
  const validSelected = detail.clips.filter(clip => selectedIds.includes(clip.id)).map(clip => clip.id);
  const series = detail.series.id;
  const toggle = (id: string) => {
    setSelectedIds(cur => cur.includes(id) ? cur.filter(item => item !== id) : cur.length < 10 ? [...cur, id] : cur);
  };
  const selectPending = () => {
    const plan = computeComicBatchPlan(detail.clips, mode);
    if (plan.batchIds.length > 0) {
      setSelectedIds(plan.batchIds);
      setError("");
      return;
    }
    setSelectedIds([]);
    if (plan.allCompleted) {
      setError(mode === "keyframe"
        ? "全部首帧已审核完成；如需重新生成，请手动勾选分镜后再预览费用。"
        : "全部视频已采用完成；如需重新生成，请手动勾选分镜后再预览费用。");
    }
  };
  const preview = async () => {
    if (!validSelected.length) return;
    setBusy(true); setError("");
    try {
      const current = await getSaved();
      if (!current) return;
      const targets = current.clips.filter(row => validSelected.includes(row.id)).map(clip => ({
        clipId: clip.id, expectedRevision: clip.revision,
      }));
      if (!targets.length) return;
      setQuote(await comicDirectorApi.quote(series, {
        expectedSeriesRevision: current.series.revision, mode, targets,
      }, AbortSignal.timeout(20_000)));
      changed();
    } catch (error) { setError(comicDirectorError(error)); }
    finally { setBusy(false); }
  };
  return <details className="comic-director-proposal">
    <summary>{t("导演生成确认")}</summary>
    <fieldset disabled={disabled || busy}>
      <div className="comic-actions">
        <select value={mode} aria-label={t("生成模式")} onChange={event => setMode(event.target.value as ComicGenerationMode)}>
          <option value="keyframe">{t("生成首帧")}</option><option value="from_keyframe">{t("用已确认首帧")}</option>
          <option value="references">{t("直接生成视频")}</option>
          {comicVideoProfile(detail.series.videoModel)?.operations.includes("edit") && <option value="edit">{t("编辑源视频")}</option>}
          {comicVideoProfile(detail.series.videoModel)?.operations.includes("extend") && <option value="extend">{t("延长源视频")}</option>}
        </select>
        <button type="button" onClick={selectPending} disabled={!detail.clips.length}>{t("全选未完成")}</button>
      </div>
      <div className="comic-ref-checklist" role="group" aria-label={t("选择生成分镜")}>
        {detail.clips.map(clip => (
          <label key={clip.id} className="comic-video-replace">
            <input type="checkbox" checked={validSelected.includes(clip.id)}
              disabled={!validSelected.includes(clip.id) && validSelected.length >= 10}
              onChange={() => toggle(clip.id)} />
            <span>{labels(clip.id)}</span>
          </label>
        ))}
      </div>
      <button type="button" className="primary" disabled={!validSelected.length} onClick={() => void preview()}>
        {t("预览生成费用（{0}）", [validSelected.length])}
      </button>
    </fieldset>
    {error && <p role="alert">{t(error)}</p>}
    {quotes.map(({ quote, confirmed }) => {
      const target = quote.items[0]?.clipId;
      const summaryLabel = quote.items.length > 1 ? t("{0} 个分镜", [quote.items.length]) : (target ? labels(target) : t("分镜"));
      return <div className="comic-actions" key={quote.confirmationId}>
        {target && <span>{summaryLabel} · {t(confirmed ? "已确认生成" : "待确认费用")}</span>}
        <button type="button" disabled={disabled && !confirmed} onClick={() => {
          if (confirmed && target) openClip(target); else setQuote(quote);
        }}>{t(confirmed ? "查看分镜生成" : "查看费用确认")}</button>
      </div>;
    })}
    {quote && <GenerationQuoteDialog quote={quote} label={labels} close={() => setQuote(undefined)} editClip={editClip}
      confirm={id => comicGenerationApi.confirm({ resource: "series", id: series }, id)}
      submitted={() => { changed(); setSelectedIds([]); if (quote.items[0]) openClip(quote.items[0].clipId); }} />}
  </details>;
}

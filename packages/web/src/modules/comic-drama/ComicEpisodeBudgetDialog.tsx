import { useEffect, useId, useRef, useState } from "react";
import {
  COMIC_SPEECH_ESTIMATE_POINTS, type ComicDramaDetail, type ComicEpisodeBudget, type ComicEpisodeBudgetInput, type ComicEpisodeBudgetLine,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicGenerationApi } from "./generation-api.js";
import { comicGenerationError } from "./GenerationQuoteDialog.js";

const kindLabels: Record<ComicEpisodeBudgetLine["kind"], string> = {
  keyframe: "首帧", video: "视频", character: "角色造型", material: "图片素材", text: "文字增强", speech: "新配音",
};
const extraFields = [
  ["characterImages", "计划新增角色图（张）", 60], ["materialImages", "计划新增图片素材（张）", 60], ["speechLines", "未命中缓存的配音（句）", 60],
  ["inputTokens", "文字增强预计输入 Token", 1_000_000], ["outputTokens", "文字增强预计输出 Token", 100_000],
] as const;

export function ComicEpisodeBudgetDialog({ detail, close }: { detail: ComicDramaDetail; close: () => void }) {
  const { t, locale } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const { id, revision } = detail.series;
  const [plan, setPlan] = useState<ComicEpisodeBudgetInput>({ expectedRevision: revision });
  const [requested, setRequested] = useState<ComicEpisodeBudgetInput>({ expectedRevision: revision });
  const [result, setResult] = useState<ComicEpisodeBudget | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const ordinals = new Map(detail.clips.map(clip => [clip.id, clip.ordinal]));
  const points = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setResult(null);
    void comicGenerationApi.episodeBudget(id, { ...requested, expectedRevision: revision }, controller.signal)
      .then(data => { if (!controller.signal.aborted) setResult(data); })
      .catch(reason => { if (!controller.signal.aborted) setError(comicGenerationError(reason)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [id, requested, revision]);

  const costLabel = (line: ComicEpisodeBudgetLine) => line.kind === "text"
    ? t("输入 {0} / 输出 {1} Token", [line.inputTokens ?? 0, line.outputTokens ?? 0])
    : t(line.kind === "video" ? "{0} 秒视频" : line.kind === "speech" ? "{0} 句配音" : "{0} 张图片", [line.quantity]);
  const monetary = (items: NonNullable<ComicEpisodeBudget["costs"]>["settled"]) => items.map(({ currency, amountMicros }) =>
    new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 6 }).format(amountMicros / 1_000_000)).join(" / ");

  return <dialog ref={dialog} className="comic-dialog comic-quote comic-budget" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); close(); }}>
    <h2 id={title}>{t("整集费用预估")}</h2>
    <form onSubmit={event => { event.preventDefault(); setRequested({ ...plan }); }}>
      <label>{t("视频生成方式")}
        <select value={plan.videoMode ?? "from_keyframe"} onChange={e => setPlan({ ...plan, videoMode: e.target.value as typeof plan.videoMode })}>
          <option value="from_keyframe">{t("用已确认首帧")}</option><option value="references">{t("直接参考生成")}</option>
          <option value="edit">{t("编辑源视频")}</option><option value="extend">{t("延长源视频")}</option>
        </select>
      </label>
      <details>
        <summary>{t("补充制作计划与重做项")}</summary>
        <div className="comic-budget-fields">{extraFields.map(([field, label, max]) => <label key={field}>{t(label)}
          <input type="number" min={0} max={max} value={field === "inputTokens" || field === "outputTokens" ? plan.text?.[field] ?? 0 : plan[field] ?? 0}
            onChange={e => {
              const n = Number(e.currentTarget.value);
              const text = plan.text ?? { inputTokens: 0, outputTokens: 0 };
              setPlan(field === "inputTokens" || field === "outputTokens"
                ? { ...plan, text: { ...text, [field]: n } } : { ...plan, [field]: n });
            }} />
        </label>)}</div>
        <p className="comic-generation-note">{t("补充计划只填尚未制作的用量；共用素材只计一次，已缓存配音不计费。")}</p>
        <p className="comic-generation-note">{t("新合成约 {0} 积分/次，命中缓存为 0 积分。", [COMIC_SPEECH_ESTIMATE_POINTS])}</p>
        {detail.clips.filter(clip => clip.progress?.videoState === "ready").map(clip => <label key={clip.id} className="comic-budget-redo">
          <input type="checkbox" checked={plan.redoVideos?.includes(clip.id) ?? false} onChange={event => {
            const ids = plan.redoVideos ?? [];
            setPlan({ ...plan, redoVideos: event.target.checked ? [...ids, clip.id] : ids.filter(id => id !== clip.id) });
          }} />{t("重做分镜 {0} 的视频", [clip.ordinal])}
        </label>)}
      </details>
      <div className="comic-actions"><button type="submit" disabled={busy}>{t("重新估算")}</button></div>
    </form>
    {busy && <p role="status">{t("正在估算费用…")}</p>}
    {error && <p role="alert" className="comic-error">{t(error)}</p>}
    {result && <>
      <ul className="comic-quote-list">
        {result.items.map(line => <li key={`${line.kind}:${line.clipId ?? ""}`}>
          <div><strong>{t(kindLabels[line.kind])}{line.clipId && ` · ${t("分镜 {0}", [ordinals.get(line.clipId) ?? "—"])}`}</strong>
            <small>{line.modelId ?? "—"} · {costLabel(line)}</small>
          </div>
          <div className="comic-quote-amount">
            <strong>{line.estimatedPoints == null ? t("待报价") : t("约 {0} 积分", [points.format(line.estimatedPoints)])}</strong>
            {line.estimatedPoints !== null && line.kind !== "text" && <small>
              {t(line.kind === "video" ? "{0} 积分/秒" : line.kind === "speech" ? "{0} 积分/句" : "{0} 积分/张",
                [points.format(line.estimatedPoints / line.quantity)])}
            </small>}
          </div>
        </li>)}
      </ul>
      <div className="comic-quote-total"><strong>{t("可估积分小计")}</strong><strong>
        {result.items.length > 0 && result.unverifiedCount === result.items.length ? "—" : t("约 {0} 积分", [points.format(result.knownPoints)])}
      </strong></div>
      {result.unverifiedCount > 0 && <small>{t("{0} 项待报价，未计入小计", [result.unverifiedCount])}</small>}
      {!!result.costs?.settled.length && <p>{t("已花费 {0}", [monetary(result.costs.settled)])}</p>}
      {!!result.costs?.quotedUnbilled.length && <p>{t("未出账估算 {0}", [monetary(result.costs.quotedUnbilled)])}</p>}
      {!!result.estimatedMonetaryTotals?.length && <p>{t("预计金额小计 {0}", [monetary(result.estimatedMonetaryTotals)])}</p>}
      {!!result.costs?.pendingReconcileCount && <p>{t("待核对 {0} 笔", [result.costs.pendingReconcileCount])}</p>}
      <p className="comic-generation-note">{t("积分预估与货币金额分开显示。实际费用以模型网关账单为准。")}</p>
    </>}
    <div className="comic-actions comic-dialog-actions"><button type="button" onClick={close}>{t("关闭")}</button></div>
  </dialog>;
}

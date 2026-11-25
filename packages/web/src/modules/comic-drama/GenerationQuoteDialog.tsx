import { useEffect, useId, useRef, useState } from "react";
import type { ComicGenerationIssue, ComicGenerationQuote, ComicImageRequest } from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { libraryError } from "./LibraryParts.js";

const reasons: Partial<Record<ComicGenerationQuote["skipped"][number]["reason"], string>> = {
  NO_SHOTS: "请填写镜头描述",
  BUSY: "已有待处理的生成任务",
  PRICE_UNAVAILABLE: "费用待核实，暂不可提交",
  CAST_REFERENCE_MISSING: "缺少锁定的角色参考图",
  REFERENCE_LIMIT: "参考素材数量超出模型限制",
  PROMPT_TOO_LONG: "分镜内容过长",
  PROMPT_REFERENCE_UNBOUND: "提示词引用了本次生成未绑定的素材",
  REFERENCE_MODE_CONFLICT: "引用与生成模式冲突。请切换模式或调整分镜素材。",
  REFERENCE_UNVERIFIED: "素材文件待核实，请检查原件或重新绑定。",
  INVALID_GENERATION_REFERENCE: "引用的生成素材已失效，请重新绑定。",
  RESOLUTION_UNSUPPORTED: "输出分辨率超出模型限制",
  VIDEO_MODE_UNSUPPORTED: "当前视频模型不支持此模式",
  VIDEO_SOURCE_REQUIRED: "请选择一段源视频",
  DURATION_UNSUPPORTED: "分镜时长超出模型限制",
  KEYFRAME_NOT_CONFIRMED: "请先确认当前分镜的首帧",
  MODEL_UNAVAILABLE: "请先在剧集设置中选择支持的视频模型",
  ALREADY_COMPLETE: "已有采用版，需显式选择生成新版",
  REFERENCE_UNSUPPORTED: "参考素材规格超出模型限制",
  INVALID_MATERIAL_REFERENCE: "分镜绑定的场景或道具素材已失效，请重新选择",
};
const errors: Record<string, string> = {
  COMIC_SUBMISSIONS_PAUSED: "新生成和导出已暂停",
  CONTENT_COMPLIANCE_REJECTED: "内容未通过安全合规检查，请修改剧本、分镜或台词后重试",
  QUOTE_EXPIRED: "报价已过期，请重新询价",
  PRICE_CHANGED: "模型或价格已更新，请重新询价",
  QUOTE_STALE: "素材或分镜已更新，请重新询价",
  BUSY: "已有待处理的生成任务",
  KEYFRAME_STALE_OR_UNAVAILABLE: "首帧版本已过期或暂不可用",
  SELECTION_CONFLICT: "该分镜的采用版本已被其他窗口更新，请刷新后重试",
  RECOVERY_UNAVAILABLE: "暂不能恢复，请稍后重试",
  VIDEO_REFERENCE_ORIGIN_REQUIRED: "视频参考素材的公网访问地址尚未配置",
  INVALID_REFERENCE: "参考素材不可用，请重新选择",
  INVALID_MATERIAL_REFERENCE: "所选场景、道具或音效素材不可用，请重新选择",
  VIDEO_STALE_OR_UNAVAILABLE: "视频版本或分镜已变化，请重新读取",
  TAKE_NOT_CANCELLABLE: "此项已结束，请刷新状态",
  TAKE_NOT_RELEASABLE: "暂不能释放此项，请等待任务结束",
};
export function comicGenerationError(error: unknown) {
  return error instanceof ApiClientError && error.code ? errors[error.code] ?? libraryError(error) : libraryError(error);
}

const fields: Record<NonNullable<ComicGenerationIssue["field"]>, string> = {
  outputSeconds: "输出时长（秒）", images: "参考图数量", audio: "参考音频数量", videos: "参考视频数量", files: "参考文件总数",
  seconds: "素材时长（秒）", audioSeconds: "音频总时长（秒）", videoSeconds: "视频总时长（秒）", bytes: "文件大小（字节）",
  edge: "边长（像素）", aspect: "宽高比", fps: "帧率", pixels: "总像素", format: "文件格式", codec: "编码",
  resolution: "输出分辨率", prompt: "最终提示词", videoMode: "生成模式",
};
const referenceKindLabels = { image: "参考图", first_frame: "首帧", last_frame: "尾帧", audio: "参考音频", video: "参考视频" } as const;

export function GenerationQuoteDialog({ quote, label, close, confirm, submitted, editClip }: {
  quote: ComicGenerationQuote; label: (id: string) => string; close: () => void; editClip?: (id: string) => void;
  confirm: (confirmationId: string) => Promise<ComicImageRequest>; submitted: (result: ComicImageRequest) => void;
}) {
  const { t, locale } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const pending = useRef(false);
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [retry, setRetry] = useState<"none" | "same" | "new">("none");
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!quote.expiresAt) return;
    const timeout = setTimeout(() => setExpired(true), Math.max(0, Date.parse(quote.expiresAt) - Date.now()));
    return () => clearTimeout(timeout);
  }, [quote.expiresAt]);
  const currency = new Intl.NumberFormat(locale, {
    style: "currency", currency: quote.currency, minimumFractionDigits: 0, maximumFractionDigits: 6,
  });
  const priceUnverified = quote.totalMicros === null && quote.skipped.some(item => item.reason === "PRICE_UNAVAILABLE");
  const format = (micros: number | null) => micros === null ? (priceUnverified ? t("费用待核实") : "—") : currency.format(micros / 1_000_000);
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  const percent = new Intl.NumberFormat(locale, { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 0 });
  const describe = (issue: ComicGenerationIssue) => {
    const name = issue.label && Object.hasOwn(referenceKindLabels, issue.label)
      ? t(referenceKindLabels[issue.label as keyof typeof referenceKindLabels]) : issue.label ?? issue.mediaId?.slice(0, 8);
    const field = issue.field && t(fields[issue.field]);
    const actual = typeof issue.actual === "number" ? numberFormat.format(issue.actual) : issue.actual;
    const max = issue.max === undefined ? "" : numberFormat.format(issue.max);
    const allowed = issue.allowed ?? (issue.min === undefined ? max : `${numberFormat.format(issue.min)}–${max}`);
    const base = field && actual !== undefined
      ? allowed ? t("{0} · 实际 {1} · 允许 {2}", [field, actual, allowed]) : t("{0} · 实际 {1}", [field, actual])
      : t(reasons[issue.code] ?? "暂不能生成");
    return name ? `${name} · ${base}` : base;
  };
  const unavailable = !quote.confirmationId || retry === "new" || expired && retry !== "same";
  const submit = async () => {
    if (!quote.confirmationId || pending.current || unavailable) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await confirm(quote.confirmationId);
      if (mounted.current) { submitted(result); close(); }
    } catch (reason) {
      if (mounted.current) {
        setError(comicGenerationError(reason));
        setRetry(reason instanceof ApiClientError && reason.status < 500 ? "new" : "same");
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <dialog ref={dialog} aria-labelledby={title} className="comic-dialog comic-quote" onCancel={event => {
    event.preventDefault();
    if (!pending.current) close();
  }}>
    <h2 id={title}>{t("生成费用预览")}</h2>
    <ul className="comic-quote-list">
      {quote.items.map(item => <li key={item.clipId}>
        <div><strong>{label(item.clipId)}</strong><small>
          {item.modelId} · {t(item.unit === "second" ? "{0} 秒视频" : "{0} 张图片", [item.quantity])}
          {!!item.referenceVersions?.length && item.unit === "image" && ` · ${t("{0} 张参考图", [item.referenceVersions.length])}`}
        </small>
          {!!item.referenceVersions?.length && <small>{item.unit === "image"
            ? t("参考图版本 · {0}", [item.referenceVersions.map(ref => `V${ref.version}`).join(" / ")])
            : item.referenceVersions.map(ref => `${t(referenceKindLabels[ref.kind ?? "image"])} V${ref.version}`).join(" · ")}</small>}
          {item.sourceDurationMs !== undefined && <small>{t(
            item.followsSource ? "源视频 {0} 秒 · 自动输出时长和画幅" : "源视频 {0} 秒 · 自动输出画幅",
            [numberFormat.format(item.sourceDurationMs / 1000)])}</small>}
          {item.followsSource && item.sourceDurationMs !== undefined && item.quantity * 1000 !== Math.round(item.sourceDurationMs)
            && <small>{t("自动时长按模型上限估价")}</small>}
          {item.videoEstimateDeviation && <small>{t("同规格近 {0} 笔实扣相对估价的常见偏差为 {1} 至 {2}", [
            item.videoEstimateDeviation.sampleCount, percent.format(item.videoEstimateDeviation.low), percent.format(item.videoEstimateDeviation.high),
          ])}</small>}
          {item.advisories?.map(advisory => <small key={advisory.code + (advisory.unit ?? "")}>{advisory.code === "PROMPT_LIMIT_UNVERIFIED"
            ? t("提示词硬上限待核实")
            : t(advisory.unit === "chars" ? "最终提示词含 {0} 个汉字，建议最多 {1} 个"
              : "最终提示词含 {0} 个英文词，建议最多 {1} 个", [advisory.actual ?? 0, advisory.max ?? 0])}</small>)}
        </div>
        <strong className="comic-quote-amount">{format(item.amountMicros)}</strong>
      </li>)}
      {quote.skipped.map(item => <li key={item.clipId}>
        <div><strong>{label(item.clipId)}</strong><small>
          {item.issues?.length ? t(reasons[item.reason] ?? "暂不能生成") : item.referenceLimit ? t("最多使用 {0} 张参考图", [item.referenceLimit])
          : item.durationLimit ? t("视频时长须为 4 至 {0} 整秒", [item.durationLimit]) : t(reasons[item.reason] ?? "暂不能生成")}</small>
        {item.issues?.map((issue, index) => issue.field || issue.label || issue.mediaId
          ? <small key={index}>{describe(issue)}</small> : null)}
        {!!item.invalidReferences?.length && <small>
          {item.invalidReferences.map(ref => `${ref.name ?? ref.materialId.slice(0, 8)} (${t(
            ref.reason === "ARCHIVED" ? "已归档" : ref.reason === "OUTDATED_VERSION" ? "已有新版"
              : ref.reason === "WRONG_KIND" ? "类别不符" : "已缺失",
          )})`).join(" · ")}
        </small>}
        </div>
        {editClip && !["BUSY", "PRICE_UNAVAILABLE", "ALREADY_COMPLETE"].includes(item.reason)
          ? <button type="button" disabled={busy} onClick={() => { close(); editClip(item.clipId); }}>{t("编辑分镜")}</button>
          : <span>{t("跳过")}</span>}
      </li>)}
    </ul>
    <div className="comic-quote-total"><strong>{t("预估合计")}</strong><strong>{format(quote.totalMicros)}</strong></div>
    {quote.videoTokenEstimate && quote.items.some(item => !item.videoEstimateDeviation) && <p className="comic-generation-note">
      {t("视频 Token 预估会受实际时长、画幅和通道计量规则影响。误差范围待通道实测。")}
    </p>}
    {quote.items.length > 0 && <p className="comic-generation-note">{t("实际费用以模型网关账单为准。")}</p>}
    {(error || expired) && <p className="comic-error" role="alert">{t(error || "报价已过期，请重新询价")}</p>}
    <div className="comic-actions comic-dialog-actions">
      <button type="button" autoFocus disabled={busy} onClick={close}>{t("取消")}</button>
      <button type="button" className="primary" disabled={busy || unavailable} onClick={() => void submit()}>
        {t(busy ? "提交中…" : "确认费用并生成")}
      </button>
    </div>
  </dialog>;
}

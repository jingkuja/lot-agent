import { useEffect, useId, useRef, useState } from "react";
import type { ComicGenerationQuote, ComicImageRequest } from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { libraryError } from "./LibraryParts.js";

const reasons: Partial<Record<ComicGenerationQuote["skipped"][number]["reason"], string>> = {
  NO_SHOTS: "请填写镜头描述",
  BUSY: "已有待处理的生成任务",
  PRICE_UNAVAILABLE: "图片模型或报价暂不可用",
  CAST_REFERENCE_MISSING: "缺少锁定的角色参考图",
  REFERENCE_LIMIT: "参考图数量超出模型限制",
  PROMPT_TOO_LONG: "分镜内容过长",
  DURATION_UNSUPPORTED: "视频时长须为 4 至 15 整秒",
  KEYFRAME_NOT_CONFIRMED: "请先确认当前分镜的首帧",
  MODEL_UNAVAILABLE: "请先在剧集设置中选择支持的视频模型",
  ALREADY_COMPLETE: "已有采用版，需显式选择生成新版",
  REFERENCE_UNSUPPORTED: "参考图的格式、尺寸或大小超出模型限制",
};
const errors: Record<string, string> = {
  QUOTE_EXPIRED: "报价已过期，请重新询价",
  PRICE_CHANGED: "模型或价格已更新，请重新询价",
  QUOTE_STALE: "素材或分镜已更新，请重新询价",
  BUSY: "已有待处理的生成任务",
  KEYFRAME_STALE_OR_UNAVAILABLE: "首帧版本已过期或暂不可用",
  RECOVERY_UNAVAILABLE: "暂不能恢复，请稍后重试",
  VIDEO_REFERENCE_ORIGIN_REQUIRED: "视频参考图的公网访问地址尚未配置",
  INVALID_REFERENCE: "参考素材不可用，请重新选择",
  VIDEO_STALE_OR_UNAVAILABLE: "视频版本或分镜已变化，请重新读取",
  TAKE_NOT_CANCELLABLE: "此项已结束，请刷新状态",
  TAKE_NOT_RELEASABLE: "暂不能释放此项，请等待任务结束",
};
export function comicGenerationError(error: unknown) {
  return error instanceof ApiClientError && error.code ? errors[error.code] ?? libraryError(error) : libraryError(error);
}

export function GenerationQuoteDialog({ quote, label, close, confirm, submitted }: {
  quote: ComicGenerationQuote; label: (id: string) => string; close: () => void;
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
  const currency = new Intl.NumberFormat(locale, { style: "currency", currency: quote.currency, maximumFractionDigits: 6 });
  const format = (micros: number | null) => micros === null ? "—" : currency.format(micros / 1_000_000);
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
          {!!item.referenceVersions?.length && ` · ${t("{0} 张参考图", [item.referenceVersions.length])}`}
        </small>
          {!!item.referenceVersions?.length && <small>{t("参考图版本 · {0}", [item.referenceVersions.map(ref => `V${ref.version}`).join(" / ")])}</small>}
        </div>
        <strong className="comic-quote-amount">{format(item.amountMicros)}</strong>
      </li>)}
      {quote.skipped.map(item => <li key={item.clipId}>
        <div><strong>{label(item.clipId)}</strong><small>{item.referenceLimit ?
          t("最多使用 {0} 张参考图", [item.referenceLimit]) : t(reasons[item.reason] ?? "暂不能生成")}</small></div>
        <span>{t("跳过")}</span>
      </li>)}
    </ul>
    <div className="comic-quote-total"><strong>{t("预估合计")}</strong><strong>{format(quote.totalMicros)}</strong></div>
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

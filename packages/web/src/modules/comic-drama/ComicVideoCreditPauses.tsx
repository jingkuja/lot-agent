import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ComicVideoCreditPause } from "@lot-agent/core/comic-drama";
import { RechargeModal } from "../../components/RechargeModal.js";
import { useI18n } from "../../i18n/index.js";
import { comicGenerationApi } from "./generation-api.js";
import { useGenerationHistory } from "./GenerationHistory.js";
import { comicGenerationError } from "./GenerationQuoteDialog.js";

const warningLabels = {
  insufficient: "积分消耗快尽，为避免任务执行中途中断，请充值后继续使用。",
  "gateway-insufficient": "模型网关余额不足，补足额度后可重新检查积分。",
  unavailable: "暂时无法核实视频所需积分或余额，未提交生成。",
};

export function ComicVideoCreditPauses({ seriesId, label }: { seriesId: string; label: (clipId: string) => string }) {
  const load = useCallback((signal: AbortSignal) => comicGenerationApi.creditPauses(seriesId, signal), [seriesId]);
  const { current, refresh } = useGenerationHistory(load, 4_000);
  return current?.map(pause => <CreditPause key={pause.takeId} pause={pause} label={label(pause.clipId)} refresh={refresh} />);
}

function CreditPause({ pause, label, refresh }: { pause: ComicVideoCreditPause; label: string; refresh: () => void }) {
  const { t, locale } = useI18n();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [recharge, setRecharge] = useState(false);
  const [error, setError] = useState("");
  const check = pause.check;
  const points = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
  async function resume(override: boolean) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try { await comicGenerationApi.resumeCredits(pause.takeId, override); }
    catch (reason) { setError(comicGenerationError(reason)); }
    finally { refresh(); setBusy(false); pending.current = false; }
  }
  return <section className="comic-edit-card comic-credit-pause" aria-label={t("视频积分检查")}>
    <p role="alert"><strong>{label} · </strong>{t(warningLabels[check.reason])}</p>
    {check.reason === "insufficient" && <small>{t("当前可用 {0} 积分，预计需要 {1} 积分", [
      points.format(check.availablePoints), points.format(check.requiredPoints),
    ])}</small>}
    {error && <p className="comic-error" role="alert">{t(error)}</p>}
    <div className="comic-actions">
      {check.reason === "insufficient" && <button className="primary" type="button" onClick={() => setRecharge(true)}>{t("去充值")}</button>}
      <button type="button" disabled={busy || !pause.canResume} onClick={() => void resume(false)}>{t("重新检查积分")}</button>
      {check.reason === "insufficient" && <button type="button" disabled={busy || !pause.canResume} onClick={() => void resume(true)}>
        {t("继续生成")}
      </button>}
    </div>
    {recharge && createPortal(<RechargeModal onClose={() => setRecharge(false)} />, document.body)}
  </section>;
}

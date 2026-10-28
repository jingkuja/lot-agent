import { useEffect, useRef, useState } from "react";
import { MARKETING_KEY_ART_PATIENCE_MS, type MarketingKeyArt } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { Hint } from "./StudioFields.js";
import { WaitStatus } from "./WaitStatus.js";

/** When the running still started, by this browser's clock; it stays put between polls so the time does not jump,
 * and moves when the server reports another try. Null when no still is running or the time is unknown. */
function useRunningSince(keyArt: MarketingKeyArt | null) {
  const since = useRef<number | null>(null);
  const elapsed = keyArt?.status === "running" ? keyArt.elapsedMs : undefined;
  const estimate = elapsed === undefined ? null : Date.now() - elapsed;
  if (estimate === null) since.current = null;
  else if (since.current === null || Math.abs(since.current - estimate) > 5000) since.current = estimate;
  return since.current;
}

/** One still of the presenter with the product in the main setting, sent with every clip and shot
 * redo so hair, outfit, product and setting stay the same across shots. Each still is a billed image request.
 * It is made in the background; after MARKETING_KEY_ART_PATIENCE_MS a running still may be made again. */
export function KeyArtPanel({ keyArt, full, total, busy, onGenerate }: {
  /** The still of the saved draft's current look; null until it is loaded for its version. */
  keyArt: MarketingKeyArt | null;
  /** No reference image place is left for the still under the clip model's total. */
  full: boolean; total: number;
  busy: boolean;
  onGenerate(redo: boolean): void;
}) {
  const { t } = useI18n();
  const status = keyArt?.status;
  const running = status === "running";
  const made = status === "succeeded" || status === "failed";
  // A paid still whose download or wait was cut short is fetched again without a new charge.
  const resumable = keyArt?.resumable === true;
  const since = useRunningSince(keyArt);
  const [now, setNow] = useState(() => Date.now());
  const patient = since !== null && now - since >= MARKETING_KEY_ART_PATIENCE_MS;
  // One render when the patience time passes, which enables making the still again.
  useEffect(() => {
    if (since === null || patient) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, since + MARKETING_KEY_ART_PATIENCE_MS - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [since, patient, now]);
  const label = running ? patient ? "重新生成" : "正在生成…" : resumable ? "继续获取" : status === "succeeded" ? "换一张" : status === "failed" ? "重新生成" : "生成定妆图";
  return <section className="mv-key-art" aria-label={t("定妆图")}>
    <div className="mv-section-head"><h3>{t("定妆图")}</h3>
      {!full && <button className="mv-soft" disabled={busy || !keyArt || (running && !patient)} onClick={() => onGenerate(running || (made && !resumable))}>
        {t(label)}
      </button>}
    </div>
    <Hint text="定妆图是各镜头共用的参考图，减少镜头间人物、服装、产品和场景的差异（每次约消耗 50 积分）。" more={[t("按统一人物、产品与场景设定和已选参考图生成。"),
      t("没有产品图时，产品外观以这张图为准。"), t("修改设定、主题、比例或参考图后需重新生成。")]} />
    {full ? <p className="mv-hint" role="status">{t("定妆图占用 1 张参考图，当前视频模型合计最多 {0} 张，请先移除一张参考图。", [total])}</p> : <>
      {keyArt?.url && <img className="mv-key-art-image" src={keyArt.url} alt={t("定妆图")} />}
      {running && since !== null ? <WaitStatus label="正在生成定妆图" started={since} textRequest={false} expectedSec={MARKETING_KEY_ART_PATIENCE_MS / 1000}
        note="可以离开页面，完成后会自动显示。"
        slowNote="复杂构图需要更多时间，最长约 5 分钟。可以继续等待，也可以重新生成，或不等定妆图直接生成视频。" />
        : running ? <p className="mv-hint" role="status">{t("正在生成定妆图，可以离开页面，完成后会自动显示。")}</p>
        : keyArt?.url ? null
        : status === "failed" && !keyArt?.error ? <p className="mv-narration-error">{t("定妆图生成失败，可重新生成，或不使用定妆图直接制作。")}</p>
        : status === "missing" ? <p className="mv-hint" role="status">{t("尚未生成定妆图。")}</p> : null}
    </>}
    {!full && !running && keyArt?.error && <p className="mv-narration-error" role="status">{t(keyArt.error)}</p>}
  </section>;
}

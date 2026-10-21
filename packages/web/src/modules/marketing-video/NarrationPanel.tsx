import { useEffect, useRef, useState } from "react";
import { marketingNarrationFits, type MarketingNarrationClip, type MarketingShot } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { narrationAudio } from "./api.js";

/** Listening is free: the saved take is read back, never synthesized again. */
function TakePlayer({ projectId, slot, durationMs }: { projectId: string; slot: number; durationMs: number }) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  // A new take of the same shot has another duration; drop the old recording.
  useEffect(() => { setUrl(""); setError(""); }, [projectId, slot, durationMs]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => () => abort.current?.abort(), []);
  async function load() {
    const controller = new AbortController(); abort.current?.abort(); abort.current = controller;
    setLoading(true); setError("");
    try {
      const blob = await narrationAudio(projectId, slot, controller.signal);
      if (!controller.signal.aborted) setUrl(URL.createObjectURL(blob));
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "配音加载失败，请重试。"); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  if (url) return <audio src={url} controls autoPlay aria-label={t("第 {0} 镜配音试听", [slot + 1])} />;
  return <>
    <button type="button" disabled={loading} onClick={() => void load()}>{t(loading ? "正在加载…" : "试听")}</button>
    {error && <span className="mv-narration-error" role="alert">{t(error)}</span>}
  </>;
}

/** Per-shot twin narration: generate, listen, redo single shots, and fit shot times to the takes. */
export function NarrationPanel({ projectId, shots, clips, busy, onSynthesize, onFit }: {
  projectId: string | undefined; shots: MarketingShot[];
  /** Takes of the saved draft; null until they are loaded for its current version. */
  clips: MarketingNarrationClip[] | null;
  busy: boolean;
  onSynthesize(slots?: number[]): void; onFit(): void;
}) {
  const { t } = useI18n();
  const missing = !clips || clips.some(clip => clip.status === "missing");
  const tooLong = !!clips?.some((clip, i) => clip.durationMs !== undefined && shots[i] && !marketingNarrationFits(clip.durationMs, shots[i].durationSec ?? 15));
  const status = (clip: MarketingNarrationClip | undefined) => !clip || clip.status === "missing" ? "未生成" : clip.status === "running" ? "正在合成" : clip.status === "failed" ? "合成失败" : "";
  return <section className="mv-narration" aria-label={t("数字分身配音")}>
    <div className="mv-section-head"><h3>{t("数字分身配音")}</h3>
      <button className="mv-soft" disabled={busy || !projectId || !missing} onClick={() => onSynthesize()}>{t(clips?.some(clip => clip.status !== "missing") ? "生成缺少的配音" : "生成配音")}</button>
    </div>
    <p className="mv-hint">{t("逐镜用数字分身原声合成并保存，生成视频前请逐镜试听。修改某镜口播、音色、语速或语气后需重新生成；每次合成由模型账号计费。")}</p>
    <ol className="mv-narration-list">{shots.map((shot, i) => {
      const clip = clips?.[i];
      const fits = clip?.durationMs === undefined || marketingNarrationFits(clip.durationMs, shot.durationSec ?? 15);
      return <li key={i} className={fits ? "" : "mv-narration-long"}>
        <span>{t("第 {0} 镜", [i + 1])}</span>
        {clip?.durationMs !== undefined
          ? <small>{t("配音 {0} 秒 / 镜头 {1} 秒", [(clip.durationMs / 1000).toFixed(1), shot.durationSec ?? 15])}{!fits && ` · ${t("配音长于镜头")}`}</small>
          : <small>{t(status(clip))}</small>}
        <div className="mv-narration-actions">
          {clip?.durationMs !== undefined && projectId && <TakePlayer projectId={projectId} slot={i} durationMs={clip.durationMs} />}
          {(clip?.status === "succeeded" || clip?.status === "failed") && <button type="button" disabled={busy} onClick={() => onSynthesize([i])}>{t("重新生成")}</button>}
        </div>
      </li>;
    })}</ol>
    {tooLong && <div className="mv-audio-notice" role="status">
      <p>{t("有分镜的配音长于镜头时长。可按配音自动加长这些分镜（总时长仍在目标至目标 +5 秒内），或精简口播、调快语速后重新生成。")}</p>
      <button className="mv-primary" disabled={busy} onClick={onFit}>{t("按配音调整分镜时长")}</button>
    </div>}
  </section>;
}

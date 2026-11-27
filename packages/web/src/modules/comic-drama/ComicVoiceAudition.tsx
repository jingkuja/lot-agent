import { useEffect, useRef, useState } from "react";
import { COMIC_SPEECH_ESTIMATE_POINTS, type ComicSpeechTake, type ComicVoiceAudition } from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { comicEditApi, editError } from "./edit-api.js";
import { DictionaryOptions, MediaPreview, useComicChoices } from "./LibraryParts.js";

export function ComicVoiceAuditionPanel({ voice, initialText }: { voice: ComicVoiceAudition["voice"] | null; initialText?: string }) {
  const { t } = useI18n();
  const emotions = useComicChoices("emotion");
  const [sampleText, setSampleText] = useState(initialText ?? "");
  const [speed, setSpeed] = useState(1);
  const [emotionKey, setEmotionKey] = useState("");
  const [auditioning, setAuditioning] = useState(false);
  const [auditionError, setAuditionError] = useState("");
  const [auditionUnknown, setAuditionUnknown] = useState<ComicVoiceAudition | null>(null);
  const [auditionTake, setAuditionTake] = useState<ComicSpeechTake | null>(null);
  const activeAudition = useRef<AbortController | null>(null);

  const voiceKey = JSON.stringify(voice);
  useEffect(() => {
    setAuditioning(false);
    setAuditionError("");
    setAuditionUnknown(null);
    setAuditionTake(null);
    return () => {
      activeAudition.current?.abort();
      activeAudition.current = null;
    };
  }, [voiceKey]);
  const defaultSample = t("雨停之前，我们把剩下的故事说完吧。");

  const runAudition = async () => {
    if (!voice || activeAudition.current) return;
    const payload = { text: sampleText.trim() || defaultSample, speed, emotionKey: emotionKey || null, voice };
    const controller = new AbortController();
    activeAudition.current = controller;
    setAuditioning(true);
    setAuditionError("");
    setAuditionUnknown(null);
    setAuditionTake(null);
    try {
      const take = await comicEditApi.auditionVoice(payload, controller.signal);
      if (!controller.signal.aborted) setAuditionTake(take);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setAuditionError(editError(reason));
        if (reason instanceof ApiClientError && reason.code === "EDIT_SPEECH_UNKNOWN") setAuditionUnknown(payload);
      }
    } finally {
      if (activeAudition.current === controller) activeAudition.current = null;
      if (!controller.signal.aborted) setAuditioning(false);
    }
  };

  const releaseAudition = async () => {
    if (activeAudition.current) return;
    const payload = auditionUnknown;
    if (!payload) return;
    if (!window.confirm(t("原配音请求可能已扣费。释放后可重新合成，新请求可能再次扣费。确认释放？"))) return;
    const controller = new AbortController();
    activeAudition.current = controller;
    setAuditioning(true);
    setAuditionError("");
    try {
      await comicEditApi.releaseAuditionVoice({ ...payload, acknowledgePossibleCharge: true }, controller.signal);
      if (!controller.signal.aborted) setAuditionUnknown(null);
    } catch (reason) {
      if (!controller.signal.aborted) setAuditionError(editError(reason));
    } finally {
      if (activeAudition.current === controller) activeAudition.current = null;
      if (!controller.signal.aborted) setAuditioning(false);
    }
  };

  if (!voice) return null;
  return <section className="comic-subcard comic-voice-audition">
    <strong>{t("音色试听")}</strong>
    <small>{t("新合成约 {0} 积分/次，命中缓存为 0 积分。", [COMIC_SPEECH_ESTIMATE_POINTS])}</small>
    <label>{t("试听台词")}<input maxLength={300} value={sampleText} placeholder={defaultSample}
      onChange={event => setSampleText(event.target.value)} /></label>
    <div className="comic-fields">
      <label>{t("情绪")}<DictionaryOptions choices={emotions} value={emotionKey} existing={emotionKey} empty="—"
        onChange={event => setEmotionKey(event.target.value)} /></label>
      <label>{t("语速")}<select value={speed} onChange={event => setSpeed(Number(event.target.value))}>
        {[0.5, 0.75, 1, 1.25, 1.5, 2].map(val => <option key={val} value={val}>{val}×</option>)}
      </select></label>
    </div>
    <div className="comic-actions">
      <button type="button" disabled={auditioning} onClick={() => void runAudition()}>
        {t(auditioning ? "正在合成…" : "试听音色")}
      </button>
      {auditionUnknown && (
        <button type="button" disabled={auditioning} onClick={() => void releaseAudition()}>
          {t("释放旧提交")}
        </button>
      )}
      {auditionTake?.cached && <small>{t("已复用缓存")}</small>}
    </div>
    {auditionError && <p className="comic-error" role="alert">{t(auditionError)}</p>}
    {auditionTake && <MediaPreview key={auditionTake.mediaId}
      media={{ id: auditionTake.mediaId, hasThumbnail: false, durationMs: auditionTake.durationMs }} title={t("配音试听")} />}
  </section>;
}

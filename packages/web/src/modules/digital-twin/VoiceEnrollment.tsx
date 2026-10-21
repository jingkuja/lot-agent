import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/index.js";
import { twinVoiceApi, type TwinVoice } from "./api.js";

/** `onReady` reports whether the cloned voice can synthesize now. */
export function VoiceEnrollment({ itemId, revisionId, initialError, onReady }: { itemId: string; revisionId: string; initialError?: string; onReady?: (ready: boolean) => void }) {
  const { t } = useI18n();
  const [voice, setVoice] = useState<TwinVoice | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true); setVoice(null); setError(initialError ?? ""); setLoadFailed(false);
    void twinVoiceApi.get(itemId, abort.signal).then(({ voice }) => {
      if (!abort.signal.aborted) { setVoice(voice); if (voice?.status === "OK") setError(""); }
    }).catch(() => { if (!abort.signal.aborted) { setError("音色状态加载失败"); setLoadFailed(true); } })
      .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [itemId, revisionId, refresh, initialError]);
  useEffect(() => { onReady?.(voice?.status === "OK"); }, [voice, onReady]);
  async function enroll() {
    if (busy) return;
    setBusy(true); setError("");
    try { setVoice((await twinVoiceApi.enroll(itemId)).voice); }
    catch (error) {
      setError(error instanceof Error ? error.message : "声音复刻暂不可用");
      // Creation may have succeeded. Reload persisted state without another write.
      try { setVoice((await twinVoiceApi.get(itemId)).voice); } catch { /* Keep the enrollment error visible. */ }
    } finally { setBusy(false); }
  }
  const status = !voice ? "尚未复刻声音" : voice.status === "OK" ? "千问音色已就绪" : voice.status === "DEPLOYING" ? "千问音色处理中" : voice.status === "UNDEPLOYED" ? "千问音色未通过审核" : "复刻结果待核实，请刷新音色状态";
  return <div className="twin-voice-enrollment">
    <p role="status">{t(status)}</p>
    {voice?.status === "unknown" && <small>{t("若千问未生成音色，约 2 分钟后刷新即可重新复刻")}</small>}
    {voice?.voiceId && <><small>{t("音色 ID")}: {voice.voiceId}</small><small>{t("语音模型")}: {voice.targetModel}</small></>}
    <div className="twin-actions">
      {(!voice || voice.status === "unknown" || voice.status === "DEPLOYING") && <button type="button" disabled={busy || loadFailed} onClick={() => void enroll()}>{busy ? t("正在处理素材…") : t(voice ? "刷新音色状态" : "复刻声音")}</button>}
      {loadFailed && <button type="button" disabled={busy} onClick={() => setRefresh(n => n + 1)}>{t("重试")}</button>}
    </div>
    {error && <p className="twin-error" role="alert">{t(error)}</p>}
    {voice?.status === "OK" && <SpeechPreview itemId={itemId} />}
  </div>;
}

/** Dubbing preview with the cloned voice. Each click is one billed synthesis. */
function SpeechPreview({ itemId }: { itemId: string }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  async function speak() {
    if (busy || !text.trim()) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError("");
    try {
      const blob = await twinVoiceApi.speak(itemId, { text: text.trim(), ...(instructions.trim() ? { instructions: instructions.trim() } : {}) }, controller.signal);
      if (!controller.signal.aborted) setUrl(URL.createObjectURL(blob));
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "配音合成失败，请稍后重试");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <div className="twin-speech">
    <label>{t("配音文案")}<textarea value={text} maxLength={500} rows={3} placeholder={t("输入要用此音色朗读的文案，最多 500 字")} onChange={e => setText(e.target.value)} /></label>
    <label>{t("语气要求（可选）")}<input value={instructions} maxLength={200} placeholder={t("例如：语气热情，语速稍快")} onChange={e => setInstructions(e.target.value)} /></label>
    <div className="twin-actions"><button type="button" disabled={busy || !text.trim()} onClick={() => void speak()}>{t(busy ? "正在合成配音…" : "合成试听")}</button></div>
    {url && <audio src={url} controls autoPlay aria-label={t("配音试听")} />}
    {error && <p className="twin-error" role="alert">{t(error)}</p>}
  </div>;
}

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/index.js";
import { knowledgeApi } from "../knowledge/api.js";
import { captureError, MAX_VOICE_SECONDS, recordingToWave, twinTag, validateTwinFile, type TwinKind } from "./media.js";

export function TwinCapture({ kind, onSaved }: { kind: TwinKind; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const voice = kind === "voice";
  const [stage, setStage] = useState<"idle" | "starting" | "recording" | "camera" | "processing">("idle");
  const [draft, setDraft] = useState<{ file: File; key: string } | null>(null);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const video = useRef<HTMLVideoElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const active = useRef(true);
  const locked = useRef(false);
  const savingRef = useRef(false);

  function stopTracks() {
    clearInterval(timer.current);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }
  function cancelCapture() {
    generation.current++;
    if (recorder.current) {
      recorder.current.onstop = null;
      recorder.current.onerror = null;
      if (recorder.current.state !== "inactive") recorder.current.stop();
      recorder.current = null;
    }
    stopTracks(); locked.current = false; setStage("idle"); setCameraReady(false);
  }
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; generation.current++; if (recorder.current) { recorder.current.onstop = null; recorder.current.onerror = null; if (recorder.current.state !== "inactive") recorder.current.stop(); } stopTracks(); };
  }, []);
  useEffect(() => {
    if (!draft) { setPreview(""); return; }
    const url = URL.createObjectURL(draft.file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [draft]);
  useEffect(() => {
    if (stage === "camera" && video.current) video.current.srcObject = stream.current;
  }, [stage]);

  async function accept(file: File) {
    await validateTwinFile(file, kind);
    if (!active.current) return;
    setDraft({ file, key: crypto.randomUUID() });
    setName(file.name.replace(/\.[^.]+$/, ""));
  }
  async function upload(file: File) {
    if (locked.current) return;
    locked.current = true; setStage("processing"); setError("");
    try { await accept(file); } catch (e) { if (active.current) setError(captureError(e)); }
    finally { locked.current = false; if (active.current) setStage("idle"); }
  }
  async function start() {
    if (locked.current) return;
    locked.current = true;
    const attempt = ++generation.current;
    setError(""); setStage("starting"); setCameraReady(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia || (voice && typeof MediaRecorder === "undefined")) {
        throw new Error("当前环境不支持录音或拍照，请使用 HTTPS、桌面客户端或上传文件。");
      }
      const media = await navigator.mediaDevices.getUserMedia(voice ? { audio: true } : { video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } } });
      if (!active.current || generation.current !== attempt) { media.getTracks().forEach((track) => track.stop()); return; }
      stream.current = media;
      if (!voice) { setStage("camera"); return; }
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((value) => MediaRecorder.isTypeSupported(value));
      const recording = new MediaRecorder(media, mime ? { mimeType: mime } : undefined);
      recorder.current = recording;
      const chunks: Blob[] = [];
      recording.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recording.onerror = () => { cancelCapture(); setError(t("采集失败，请重试或上传文件。")); };
      recording.onstop = () => {
        stopTracks(); recorder.current = null;
        if (!active.current || generation.current !== attempt) return;
        setStage("processing");
        void recordingToWave(new Blob(chunks, { type: recording.mimeType })).then(async (file) => {
          if (active.current && generation.current === attempt) await accept(file);
        }).catch((e) => { if (active.current && generation.current === attempt) setError(captureError(e)); }).finally(() => {
          if (active.current && generation.current === attempt) { locked.current = false; setStage("idle"); }
        });
      };
      recording.start(); setStage("recording"); setSeconds(0);
      const started = Date.now();
      timer.current = setInterval(() => {
        const elapsed = Math.min(MAX_VOICE_SECONDS, Math.floor((Date.now() - started) / 1000));
        setSeconds(elapsed);
        if (elapsed >= MAX_VOICE_SECONDS && recording.state === "recording") { clearInterval(timer.current); recording.stop(); setStage("processing"); }
      }, 200);
    } catch (e) {
      if (active.current && generation.current === attempt) { cancelCapture(); setError(captureError(e)); }
    }
  }
  async function takePhoto() {
    if (!video.current?.videoWidth) return;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1920 / video.current.videoWidth);
    canvas.width = Math.round(video.current.videoWidth * scale); canvas.height = Math.round(video.current.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) { setError(t("采集失败，请重试或上传文件。")); return; }
    context.drawImage(video.current, 0, 0, canvas.width, canvas.height);
    cancelCapture();
    canvas.toBlob((blob) => {
      if (active.current && blob) void upload(new File([blob], `portrait-${Date.now()}.jpg`, { type: "image/jpeg" }));
      else if (active.current) setError(t("采集失败，请重试或上传文件。"));
    }, "image/jpeg", 0.92);
  }
  async function save() {
    if (!draft || !name.trim() || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError(""); setProgress(0);
    try {
      const extension = draft.file.name.split(".").at(-1);
      const file = new File([draft.file], `${name.trim().replace(/[\\/\x00-\x1f]/g, "-")}.${extension}`, { type: draft.file.type });
      await knowledgeApi.upload([], file, draft.key, (value) => { if (active.current) setProgress(value); }, true, [twinTag(kind)]);
      if (active.current) { setDraft(null); await onSaved(); }
    } catch (e) { if (active.current) setError(captureError(e)); }
    finally { savingRef.current = false; if (active.current) setSaving(false); }
  }
  const busy = stage !== "idle" || saving;
  return <div className="twin-capture">
    <div className="twin-actions">
      <button type="button" disabled={busy} onClick={() => void start()}>{t(voice ? "录制声音" : "本机拍照")}</button>
      <button type="button" disabled={busy} onClick={() => input.current?.click()}>{t(voice ? "上传声音样例" : "上传肖像图片")}</button>
      <input ref={input} hidden type="file" accept={voice ? ".mp3,.wav" : ".jpg,.jpeg,.png,.webp"} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(file); }} />
    </div>
    {stage === "starting" && <p role="status">{t("正在请求设备权限…")} <button type="button" onClick={cancelCapture}>{t("取消")}</button></p>}
    {stage === "recording" && <div className="twin-recording"><p role="status">{t("正在录音 {0} / 15 秒", [seconds])}</p><p>{t("请自然朗读：你好，这是我的声音。我希望用它讲述故事，分享生活中的美好。")}</p><button type="button" onClick={() => { recorder.current?.stop(); setStage("processing"); }}>{t("结束录音")}</button><button type="button" onClick={cancelCapture}>{t("取消")}</button></div>}
    {stage === "processing" && <p role="status">{t("正在处理素材…")}</p>}
    {stage === "camera" && <div className="twin-camera"><video ref={video} autoPlay playsInline muted onLoadedData={() => setCameraReady(true)} aria-label={t("摄像头预览")} /><div className="twin-actions"><button type="button" disabled={!cameraReady} onClick={() => void takePhoto()}>{t("拍摄照片")}</button><button type="button" onClick={cancelCapture}>{t("取消")}</button></div></div>}
    {draft && stage === "idle" && <div className="twin-draft">
      {voice ? <audio src={preview} controls aria-label={t("声音试听")} /> : <img src={preview} alt={t("肖像预览")} />}
      <label>{t("素材名称")}<input value={name} maxLength={120} disabled={saving} onChange={(e) => setName(e.target.value)} /></label>
      <div className="twin-actions"><button type="button" className="knowledge-primary" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? t("正在保存 {0}%", [progress]) : t("保存到个人库")}</button><button type="button" disabled={saving} onClick={() => setDraft(null)}>{t("放弃")}</button></div>
    </div>}
    {error && <p className="twin-error" role="alert">{t(error)}</p>}
  </div>;
}

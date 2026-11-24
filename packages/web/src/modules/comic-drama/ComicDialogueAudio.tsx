import { useEffect, useRef, useState } from "react";
import {
  comicSpeechPresets, matchComicCharacters, type ComicSpeechLines, type ComicSpeechRequest, type ComicSpeechTake, type ComicTimeline,
} from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { comicEditApi, editError } from "./edit-api.js";
import { presetVoiceLabel } from "./ComicCharacterVoice.js";
import { MediaPreview } from "./LibraryParts.js";

type Video = ComicTimeline["video"][number];
type Audio = ComicTimeline["voice"][number];

export function ComicDialogueAudio({ projectId, revision, item, voice, subtitles, change, addSubtitle, disabled }: {
  projectId: string; revision: number; item: Video; voice: Audio[]; change: (voice: Audio[]) => void; disabled: boolean;
  subtitles: ComicTimeline["subtitles"]; addSubtitle: (subtitle: ComicTimeline["subtitles"][number]) => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<ComicSpeechLines | "error" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt(value => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    void comicEditApi.lines(projectId, item.id, controller.signal).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch(() => { if (!controller.signal.aborted) setData("error"); });
    return () => controller.abort();
  }, [projectId, item.id, item.takeId, revision, attempt]);
  const local = voice.filter(entry => entry.anchor.kind === "clip" && entry.anchor.videoItemId === item.id);
  return <section className="comic-edit-card">
    <header><h2>{t("逐句配音")}</h2><button type="button" onClick={retry}>{t("重新读取台词")}</button></header>
    {data === "error" ? <p role="alert">{t("操作失败，请重试")}</p> : data === null ? <p role="status">{t("加载中…")}</p> :
      !data.lines.length ? <p>{t("源分镜暂无台词")}</p> : <>
        <p className="comic-generation-note">{t("试听为 AI 合成。首次合成可能由模型网关收费。")}</p>
        {!data.presets.length && !data.characters.length && <p>{t("暂无可用音色")}</p>}
        {data.lines.map(line => {
          const attached = local.find(entry => entry.lineId === line.id);
          const offset = attached?.anchor.offsetMs ?? Math.max(0, ...local.map(entry => entry.anchor.offsetMs + entry.durationMs));
          const remaining = item.outMs - item.inMs - offset;
          const captionExists = subtitles.some(cue => cue.lineId === line.id && cue.anchor.kind === "clip" && cue.anchor.videoItemId === item.id);
          return <DialogueLine key={line.id} line={line} data={data} remaining={remaining} attached={attached} disabled={disabled}
            addCaption={captionExists || remaining <= 0 ? undefined : () => addSubtitle({ id: crypto.randomUUID(), lineId: line.id, text: line.text,
              anchor: { kind: "clip", videoItemId: item.id, offsetMs: offset }, durationMs: Math.min(remaining, attached?.durationMs ?? 2500) })}
            generate={(selection, signal) => comicEditApi.speak(projectId, item.id, line.id, {
              expectedRevision: revision, expectedClipRevision: data.clipRevision!, voice: selection,
            }, signal)}
            release={(selection, signal) => comicEditApi.releaseSpeech(projectId, item.id, line.id, {
              expectedRevision: revision, expectedClipRevision: data.clipRevision!, voice: selection, acknowledgePossibleCharge: true,
            }, signal)}
            attach={(take, durationMs) => {
              const entry: Audio = { id: attached?.id ?? crypto.randomUUID(), mediaId: take.mediaId, lineId: line.id,
                anchor: { kind: "clip", videoItemId: item.id, offsetMs: offset }, durationMs, sourceInMs: 0,
                volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false };
              change(attached ? voice.map(value => value.id === attached.id ? entry : value) : [...voice, entry]);
            }} remove={() => change(voice.filter(value => value.id !== attached?.id))} />;
        })}
      </>}
  </section>;
}

function DialogueLine({ line, data, remaining, attached, disabled, generate, release, attach, remove, addCaption }: {
  line: ComicSpeechLines["lines"][number]; data: ComicSpeechLines; remaining: number; attached?: Audio; disabled: boolean;
  generate: (choice: ComicSpeechRequest["voice"], signal: AbortSignal) => Promise<ComicSpeechTake>;
  release: (choice: ComicSpeechRequest["voice"], signal: AbortSignal) => Promise<{ ok: true }>;
  attach: (take: ComicSpeechTake, durationMs: number) => void; remove: () => void;
  addCaption?: () => void;
}) {
  const { t, locale } = useI18n();
  const [selection, setSelection] = useState("");
  const [take, setTake] = useState<ComicSpeechTake | null>(null);
  const [error, setError] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const matches = line.speaker ? matchComicCharacters(line.speaker, data.characters) : [];
  const choice = selection || (matches.length === 1 ? matches[0].id : data.presets[0] ?? data.characters[0]?.id ?? "");
  const voiceChoice = (): ComicSpeechRequest["voice"] => {
    const preset = comicSpeechPresets.find(key => key === choice);
    return preset ? { kind: "preset" as const, preset } : { kind: "character" as const, characterId: choice };
  };
  const synthesize = async () => {
    if (active.current || !choice) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setUnknown(false);
    try {
      const result = await generate(voiceChoice(), controller.signal);
      if (!controller.signal.aborted) setTake(result);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(editError(reason));
        setUnknown(reason instanceof ApiClientError && reason.code === "EDIT_SPEECH_UNKNOWN");
      }
    } finally { active.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  const releaseUnknown = async () => {
    if (active.current || !choice) return;
    if (!window.confirm(t("原配音请求可能已扣费。释放后可重新合成，新请求可能再次扣费。确认释放？"))) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    try {
      await release(voiceChoice(), controller.signal);
      if (!controller.signal.aborted) setUnknown(false);
    } catch (reason) {
      if (!controller.signal.aborted) setError(editError(reason));
    } finally { active.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  return <div className="comic-dialogue-line">
    <p>{line.speaker && <strong>{line.speaker} · </strong>}{line.text}</p>
    <div className="comic-actions">
      <select aria-label={t("配音音色")} value={choice} disabled={disabled || busy} onChange={event => {
        setSelection(event.target.value); setTake(null); setError(""); setUnknown(false);
      }}>
        {!choice && <option value="">{t("暂无可用音色")}</option>}
        {data.presets.map(key => (
          <option key={key} value={key}>{presetVoiceLabel(key, locale, data.presetCatalog)}</option>
        ))}
        {data.characters.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
      </select>
      <button type="button" disabled={!choice || disabled || busy} onClick={() => void synthesize()}>{t(busy ? "正在合成…" : "合成此句")}</button>
      {unknown && <button type="button" disabled={!choice || disabled || busy} onClick={() => void releaseUnknown()}>{t("释放旧提交")}</button>}
      <button type="button" disabled={disabled || !addCaption} onClick={addCaption}>{t("这句加入字幕轨")}</button>
      {attached && <button type="button" disabled={disabled} onClick={remove}>{t("移除配音")}</button>}
    </div>
    {error && <p role="alert" className="comic-error">{t(error)}</p>}
    {(take || attached) && <MediaPreview key={(take ?? attached)?.mediaId}
      media={{ id: (take ?? attached)!.mediaId, hasThumbnail: false, durationMs: (take ?? attached)!.durationMs }} title={t("配音试听")} />}
    {take && <div className="comic-actions">
      {take.cached && <small>{t("已复用缓存")}</small>}
      {take.durationMs > remaining && <small>{t("配音超出片段剩余时长")}</small>}
      <button type="button" disabled={disabled || remaining <= 0 || attached?.mediaId === take.mediaId}
        onClick={() => attach(take, Math.min(remaining, take.durationMs))}>
        {t(take.durationMs > remaining ? "裁切并加入配音轨" : "加入配音轨")}
      </button>
    </div>}
  </div>;
}

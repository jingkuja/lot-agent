import { useEffect, useRef, useState } from "react";
import {
  COMIC_SPEECH_ESTIMATE_POINTS, comicSpeechPresets, matchComicCharacters,
  type ComicSpeechLines, type ComicSpeechRequest, type ComicSpeechTake, type ComicTimeline, type ComicVideoAudioMode,
} from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { comicEditApi, editError } from "./edit-api.js";
import { presetVoiceLabel } from "./ComicCharacterVoice.js";
import { MediaPreview } from "./LibraryParts.js";

type Video = ComicTimeline["video"][number];
type Audio = ComicTimeline["voice"][number];

export type ComicDialogueClipContext = {
  index: number;
  total: number;
  clipOrdinal?: number | null;
  title: string;
  durationMs: number;
  onSelectPrev?: () => void;
  onSelectNext?: () => void;
  onLocatePreview?: () => void;
};

export function ComicDialogueAudio({
  projectId,
  revision,
  item,
  audioMode,
  voice,
  subtitles,
  change,
  addSubtitle,
  disabled,
  clipContext,
  collapsed,
  onToggleCollapse,
}: {
  projectId: string;
  revision: number;
  item: Video;
  audioMode?: ComicVideoAudioMode;
  voice: Audio[];
  change: (voice: Audio[], opts?: { muteVideo?: boolean }) => void;
  disabled: boolean;
  subtitles: ComicTimeline["subtitles"];
  addSubtitle: (subtitle: ComicTimeline["subtitles"][number]) => void;
  clipContext?: ComicDialogueClipContext;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<ComicSpeechLines | "error" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const isCollapsed = collapsed ?? localCollapsed;
  const toggleCollapse = onToggleCollapse ?? (() => setLocalCollapsed(v => !v));
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
  const hasNativeAudio = audioMode === "native_audio" || audioMode === "reference_audio";
  const attachedCount = data && data !== "error"
    ? data.lines.filter(line => local.some(entry => entry.lineId === line.id)).length
    : local.length;
  const durationSec = String(+(item.outMs - item.inMs) / 1000);
  return <section
    className={`comic-edit-card comic-dialogue-panel${isCollapsed ? " is-collapsed" : ""}`}
    aria-label={t("逐句配音")}
    onClick={isCollapsed ? toggleCollapse : undefined}
  >
    <header className="comic-stage-card-header">
      <div className="comic-stage-card-header-main">
        <h2>{t("逐句配音")}</h2>
        {!isCollapsed && <button type="button" onClick={retry}>{t("重新读取台词")}</button>}
      </div>
      <button
        type="button"
        className="comic-stage-collapse-btn"
        aria-expanded={!isCollapsed}
        aria-label={t(isCollapsed ? "展开逐句配音" : "收起逐句配音")}
        title={t(isCollapsed ? "展开逐句配音" : "收起逐句配音")}
        onClick={event => {
          event.stopPropagation();
          toggleCollapse();
        }}
      >
        <span className="comic-stage-collapse-icon" aria-hidden="true">{isCollapsed ? "«" : "»"}</span>
        <span className="comic-stage-collapse-label">{t(isCollapsed ? "展开" : "收起")}</span>
      </button>
    </header>
    <div className="comic-stage-card-body" hidden={isCollapsed}>
      {clipContext && (
        <div className="comic-dialogue-context" key={item.id}>
          <div className="comic-dialogue-context-main">
            <span className="comic-clip-index is-active">{String(clipContext.index + 1).padStart(2, "0")}</span>
            <div className="comic-dialogue-context-meta">
              <strong>{clipContext.title}</strong>
              <small>
                {clipContext.clipOrdinal ? `${t("分镜 {0}", [clipContext.clipOrdinal])} · ` : ""}
                {t("{0} 秒", [durationSec])} · {clipContext.index + 1}/{clipContext.total}
              </small>
            </div>
            {data && data !== "error" && data.lines.length > 0 ? (
              <small className="comic-pill" data-tone={attachedCount === data.lines.length ? "done" : "frame"}>
                {t("已入轨 {0}/{1} 句", [attachedCount, data.lines.length])}
              </small>
            ) : local.length > 0 ? (
              <small className="comic-pill" data-tone="done">{t("已入轨 {0} 句", [local.length])}</small>
            ) : null}
          </div>
          {(clipContext.onLocatePreview || clipContext.onSelectPrev || clipContext.onSelectNext) && (
            <div className="comic-dialogue-context-actions">
              {clipContext.onLocatePreview && (
                <button type="button" onClick={clipContext.onLocatePreview}>{t("定位预览")}</button>
              )}
              <div className="comic-dialogue-nav">
                <button
                  type="button"
                  aria-label={t("切换到上一片段")}
                  disabled={!clipContext.onSelectPrev}
                  onClick={clipContext.onSelectPrev}
                >
                  ‹
                </button>
                <button
                  type="button"
                  aria-label={t("切换到下一片段")}
                  disabled={!clipContext.onSelectNext}
                  onClick={clipContext.onSelectNext}
                >
                  ›
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {hasNativeAudio && (
        <p className="comic-generation-note" role="note">
          {item.volume > 0
            ? t("当前片段含模型原生或参考音频，默认仅需铺字幕；如手动加入后期配音，将自动把片源原声静音以避免双人声叠加。")
            : t("当前片段含模型原生或参考音频，片源原声已静音，可直接叠加后期配音。")}
        </p>
      )}
      {data === "error" ? <p role="alert">{t("操作失败，请重试")}</p> : data === null ? <p role="status">{t("加载中…")}</p> :
        !data.lines.length ? <p className="comic-dialogue-empty">{t("源分镜暂无台词")}</p> : <>
          <p className="comic-generation-note">{t("新合成约 {0} 积分/次，命中缓存为 0 积分。", [COMIC_SPEECH_ESTIMATE_POINTS])}</p>
          {!data.presets.length && !data.characters.length && <p>{t("暂无可用音色")}</p>}
          <div className="comic-dialogue-lines" key={item.id + ":" + item.takeId}>
            {data.lines.map((line, lineIndex) => {
              const attached = local.find(entry => entry.lineId === line.id);
              const offset = attached?.anchor.offsetMs ?? Math.max(0, ...local.map(entry => entry.anchor.offsetMs + entry.durationMs));
              const remaining = item.outMs - item.inMs - offset;
              const captionExists = subtitles.some(cue => cue.lineId === line.id && cue.anchor.kind === "clip" && cue.anchor.videoItemId === item.id);
              return <DialogueLine key={line.id} lineIndex={lineIndex} line={line} data={data} remaining={remaining}
                attached={attached} captionExists={captionExists} disabled={disabled}
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
                  change(
                    attached ? voice.map(value => value.id === attached.id ? entry : value) : [...voice, entry],
                    hasNativeAudio && item.volume > 0 ? { muteVideo: true } : undefined,
                  );
                }} remove={() => change(voice.filter(value => value.id !== attached?.id))} />;
            })}
          </div>
        </>}
    </div>
  </section>;
}

function DialogueLine({
  lineIndex, line, data, remaining, attached, captionExists, disabled, generate, release, attach, remove, addCaption,
}: {
  lineIndex: number; line: ComicSpeechLines["lines"][number]; data: ComicSpeechLines; remaining: number;
  attached?: Audio; captionExists: boolean; disabled: boolean;
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
  return <div className="comic-dialogue-line" data-attached={attached ? "true" : undefined}>
    <div className="comic-dialogue-line-head">
      <div className="comic-dialogue-line-who">
        <span className="comic-dialogue-line-num">#{lineIndex + 1}</span>
        {line.speaker && <strong className="comic-dialogue-speaker">{line.speaker}</strong>}
      </div>
      <div className="comic-dialogue-line-badges">
        {attached && <small className="comic-pill" data-tone="done">{t("已入轨")}</small>}
        {captionExists && <small className="comic-pill" data-tone="frame">{t("已加字幕")}</small>}
      </div>
    </div>
    <p className="comic-dialogue-text">{line.text}</p>
    <div className="comic-dialogue-controls">
      <select aria-label={t("配音音色")} value={choice} disabled={disabled || busy} onChange={event => {
        setSelection(event.target.value); setTake(null); setError(""); setUnknown(false);
      }}>
        {!choice && <option value="">{t("暂无可用音色")}</option>}
        {data.presets.map(key => (
          <option key={key} value={key}>{presetVoiceLabel(key, locale, data.presetCatalog)}</option>
        ))}
        {data.characters.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
      </select>
      <button type="button" className={!attached ? "primary" : undefined} disabled={!choice || disabled || busy} onClick={() => void synthesize()}>
        {t(busy ? "正在合成…" : "合成此句")}
      </button>
      {unknown && <button type="button" disabled={!choice || disabled || busy} onClick={() => void releaseUnknown()}>{t("释放旧提交")}</button>}
    </div>
    {error && <p role="alert" className="comic-error">{t(error)}</p>}
    {(take || attached) && (
      <div className="comic-dialogue-player">
        <MediaPreview key={(take ?? attached)?.mediaId}
          media={{ id: (take ?? attached)!.mediaId, hasThumbnail: false, durationMs: (take ?? attached)!.durationMs }} title={t("配音试听")} />
      </div>
    )}
    <div className="comic-dialogue-footer">
      {take && (
        <>
          {take.cached && <small className="comic-pill" data-tone="done">{t("已复用缓存")}</small>}
          {take.durationMs > remaining && <small className="comic-pill" data-tone="idle">{t("配音超出片段剩余时长")}</small>}
          <button type="button" className="primary" disabled={disabled || remaining <= 0 || attached?.mediaId === take.mediaId}
            onClick={() => attach(take, Math.min(remaining, take.durationMs))}>
            {t(take.durationMs > remaining ? "裁切并加入配音轨" : "加入配音轨")}
          </button>
        </>
      )}
      <button type="button" disabled={disabled || !addCaption} onClick={addCaption}>{t("这句加入字幕轨")}</button>
      {attached && (
        <button type="button" className="comic-dialogue-remove" disabled={disabled} onClick={remove}>{t("移除配音")}</button>
      )}
    </div>
  </div>;
}

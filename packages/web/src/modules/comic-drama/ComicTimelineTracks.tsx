import { useEffect, useState } from "react";
import {
  comicOverlayTracks, comicTimelineOverflow, layoutComicTimeline, type ComicEditAudioSource, type ComicEditSource,
  type ComicLibraryPage, type ComicMaterial, type ComicTimeline,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { MediaPreview } from "./LibraryParts.js";
import { comicLibraryApi } from "./library-api.js";

type Overlay = typeof comicOverlayTracks[number];
type Track = "video" | Overlay;
type Audio = ComicTimeline["voice"][number];
type Subtitle = ComicTimeline["subtitles"][number];
type Anchor = Audio["anchor"];
type Selection = { track: Overlay; id: string };
const tracks: Track[] = ["video", ...comicOverlayTracks];
const names = { video: "视频轨", voice: "配音轨", sfx: "音效轨", music: "音乐轨", subtitles: "字幕轨" };
const seconds = (value: number) => value / 1000;
const ms = (form: FormData, field: string) => Math.round(Number(form.get(field)) * 1000);
const position = (form: FormData): Anchor => {
  const id = String(form.get("anchor"));
  const offsetMs = ms(form, "offset");
  return id === "timeline" ? { kind: "timeline", offsetMs } : { kind: "clip", videoItemId: id, offsetMs };
};

function stack(items: ReturnType<typeof layoutComicTimeline>[Track]) {
  const ends: number[] = [];
  const lanes = items.map((item, index) => ({ ...item, index })).sort((a, b) => a.startMs - b.startMs).map(item => {
    const vacant = ends.findIndex(end => end <= item.startMs);
    const lane = vacant === -1 ? ends.length : vacant;
    ends[lane] = item.endMs;
    return { ...item, lane };
  });
  return { lanes, rows: Math.max(1, ends.length) };
}

export function ComicTimelineTracks({ timeline, videoSources, audioSources, selectedVideo, positionMs, seek, selectVideo, update, disabled }: {
  timeline: ComicTimeline; videoSources: ComicEditSource[]; audioSources: ComicEditAudioSource[]; selectedVideo?: string;
  positionMs: number; seek: (ms: number) => void; selectVideo: (id: string) => void; update: (timeline: ComicTimeline) => void; disabled: boolean;
}) {
  const { t } = useI18n();
  const [selection, setSelection] = useState<Selection>();
  const [picker, setPicker] = useState<"music" | "sfx">();
  const [added, setAdded] = useState<ComicEditAudioSource[]>([]);
  const [formError, setFormError] = useState("");
  const layout = layoutComicTimeline(timeline);
  const total = Math.max(1, layout.durationMs);
  const playhead = Math.min(positionMs, layout.durationMs);
  const overflow = new Set(comicTimelineOverflow(timeline));
  const selected = selection && timeline[selection.track].find(item => item.id === selection.id);
  const selectedAudio = selected && "mediaId" in selected ? selected : undefined;
  const length = selectedAudio && [...audioSources, ...added].find(source => source.id === selectedAudio.mediaId)?.durationMs;
  const choose = (track: Track, id: string, startMs: number) => {
    setFormError("");
    if (track === "video") { setSelection(undefined); selectVideo(id); }
    else setSelection({ track, id });
    seek(startMs);
  };
  const replace = (edit: Audio | Subtitle) => {
    if (!selection) return;
    const track = selection.track;
    if ("mediaId" in edit && track !== "subtitles") {
      if ((length && (edit.sourceInMs >= length || (!edit.loop && edit.sourceInMs + edit.durationMs > length))) ||
        edit.fadeInMs + edit.fadeOutMs > edit.durationMs) {
        setFormError("请检查音频源范围及淡入淡出时长");
        return;
      }
      update({ ...timeline, [track]: timeline[track].map(item => item.id === edit.id ? edit : item) });
    } else if (!("mediaId" in edit) && track === "subtitles") {
      update({ ...timeline, subtitles: timeline.subtitles.map(item => item.id === edit.id ? edit : item) });
    }
    setFormError("");
  };
  const insertAudio = (track: "music" | "sfx", material: ComicMaterial) => {
    const durationMs = material.media.durationMs;
    if (!durationMs) return;
    const offsetMs = playhead < layout.durationMs ? playhead : 0;
    const id = crypto.randomUUID();
    const edit: Audio = { id, mediaId: material.media.id, anchor: { kind: "timeline", offsetMs },
      durationMs: Math.min(durationMs, layout.durationMs - offsetMs), sourceInMs: 0,
      volume: track === "music" ? 0.3 : 1, fadeInMs: 0, fadeOutMs: 0, loop: false };
    setAdded(values => [...values, { id: material.media.id, durationMs }]);
    update({ ...timeline, [track]: [...timeline[track], edit] });
    setSelection({ track, id });
    setFormError("");
    setPicker(undefined);
  };
  const addSubtitle = (form: FormData) => {
    const text = String(form.get("text") ?? "").trim();
    if (!text) return;
    const offsetMs = playhead < layout.durationMs ? playhead : 0;
    const id = crypto.randomUUID();
    update({ ...timeline, subtitles: [...timeline.subtitles, { id, text, anchor: { kind: "timeline", offsetMs },
      durationMs: Math.min(2500, layout.durationMs - offsetMs) }] });
    setFormError("");
    setSelection({ track: "subtitles", id });
  };
  function itemTitle(track: Track, index: number) {
    if (track === "video") {
      const source = videoSources.find(meta => meta.takeId === timeline.video[index].takeId);
      return source?.scene || source?.seriesTitle || t(names[track]);
    }
    if (track === "subtitles") return timeline.subtitles[index].text;
    return t("轨道条目 {0}", [index + 1]);
  }
  return <section className="comic-edit-card comic-multitrack">
    <header><h2>{t("工程时间线")}</h2><output>{t("{0} / {1} 秒", [seconds(playhead), seconds(layout.durationMs)])}</output></header>
    <div className="comic-track-ruler">
      <label>{t("定位播放位置")}<input type="range" min={0} max={total} step={1} value={playhead} disabled={!layout.durationMs}
        onChange={event => seek(Number(event.target.value))} /></label>
      <div aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <span key={index}>{t("{0} 秒", [Math.round(total * index / 40) / 100])}</span>)}</div>
    </div>
    {tracks.map(track => {
      const { lanes, rows } = stack(layout[track]);
      return <div key={track} className="comic-track-row">
        <span>{t(names[track])}</span>
        <div className="comic-track-lane" data-track={track} style={{ height: `calc(var(--comic-track-row, 2.25rem) * ${rows})` }}>
          {lanes.map(({ id, startMs, endMs, index, lane }) => {
          const title = itemTitle(track, index);
          const start = Math.min(99, startMs / total * 100);
          const width = Math.min(100 - start, (endMs - startMs) / total * 100);
          const pressed = track === "video" ? selectedVideo === id && !selection : selection?.id === id;
          return <button key={id} type="button" title={title} aria-label={t("{0} · {1} 秒", [title, seconds(startMs)])} aria-pressed={pressed}
            data-overflow={overflow.has(id)}
            style={{ insetInlineStart: `${start}%`, width: `${width}%`, top: `calc(var(--comic-track-row, 2.25rem) * ${lane} + 3px)` }}
            onClick={() => choose(track, id, Math.min(startMs, layout.durationMs))}>{title}</button>;
          })}
          <i aria-hidden="true" style={{ insetInlineStart: `${playhead / total * 100}%` }} />
        </div>
      </div>;
    })}
    {!!overflow.size && <p className="comic-error" role="alert">{t("有配音、音乐、音效或字幕超出可用时间，请调整后导出")}</p>}
    {!!layout.durationMs && <fieldset className="comic-track-editor" disabled={disabled}>
      <div className="comic-actions">
        <button type="button" onClick={() => setPicker("music")}>{t("添加音乐")}</button>
        <button type="button" onClick={() => setPicker("sfx")}>{t("添加音效")}</button>
        <form className="comic-actions" onSubmit={event => {
          event.preventDefault();
          addSubtitle(new FormData(event.currentTarget));
          event.currentTarget.reset();
        }}>
          <input aria-label={t("字幕文字")} name="text" maxLength={2000} required />
          <button type="submit">{t("在播放头添加字幕")}</button>
        </form>
      </div>
      {picker && <AudioPicker track={picker} choose={material => insertAudio(picker, material)} close={() => setPicker(undefined)} />}
      {selection && selected && <div className="comic-track-inspector">
        <h3>{t(names[selection.track])}</h3>
        {overflow.has(selected.id) && <p className="comic-error">{t("此条目超出了锚点允许的时长")}</p>}
        {formError && <p className="comic-error" role="alert">{t(formError)}</p>}
        <OverlayFields key={JSON.stringify(selected)} item={selected} video={timeline.video} apply={replace} remove={() => {
          update({ ...timeline, [selection.track]: timeline[selection.track].filter(item => item.id !== selected.id) });
          setSelection(undefined);
        }} />
        {selectedAudio && length && <MediaPreview key={selectedAudio.mediaId}
          media={{ id: selectedAudio.mediaId, hasThumbnail: false, durationMs: length }} title={t("试听源音频")} />}
      </div>}
      {!!timeline.subtitles.length && <CaptionStyleFields timeline={timeline} change={captionStyle => update({ ...timeline, captionStyle })} />}
    </fieldset>}
  </section>;
}

function OverlayFields({ item, video, apply, remove }: {
  item: Audio | Subtitle; video: ComicTimeline["video"]; apply: (item: Audio | Subtitle) => void; remove: () => void;
}) {
  const { t } = useI18n();
  const isAudio = "mediaId" in item;
  return <form className="comic-overlay-fields" onSubmit={event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const common = { anchor: position(form), durationMs: ms(form, "duration") };
    apply(isAudio ? { ...item, ...common, sourceInMs: ms(form, "source"), volume: Number(form.get("volume")) / 100,
      fadeInMs: ms(form, "fadeIn"), fadeOutMs: ms(form, "fadeOut"), loop: form.get("loop") === "on" }
      : { ...item, ...common, text: String(form.get("text") ?? "") });
  }}>
    <label>{t("时间锚点")}<select name="anchor" aria-label={t("时间锚点")} defaultValue={item.anchor.kind === "clip" ? item.anchor.videoItemId : "timeline"}>
      <option value="timeline">{t("工程起点")}</option>
      {video.map((clip, index) => <option key={clip.id} value={clip.id}>{t("片段 {0}", [index + 1])}</option>)}
    </select></label>
    <TimeField label={t("偏移（秒）")} name="offset" value={item.anchor.offsetMs} />
    <TimeField label={t("时长（秒）")} name="duration" value={item.durationMs} min={0.001} />
    {isAudio ? <>
      <TimeField label={t("音频入点（秒）")} name="source" value={item.sourceInMs} />
      <TimeField label={t("淡入（秒）")} name="fadeIn" value={item.fadeInMs} />
      <TimeField label={t("淡出（秒）")} name="fadeOut" value={item.fadeOutMs} />
      <label>{t("音量（%）")}<input name="volume" type="number" min={0} max={200} required defaultValue={Math.round(item.volume * 100)} /></label>
      <label className="comic-track-loop"><input type="checkbox" name="loop" defaultChecked={item.loop} />{t("循环")}</label>
    </> : <label>{t("字幕文字")}<textarea aria-label={t("字幕文字")} name="text" required maxLength={2000} defaultValue={item.text} /></label>}
    <div className="comic-actions"><button type="submit">{t("应用轨道设置")}</button><button type="button" onClick={remove}>{t("移除")}</button></div>
  </form>;
}

function TimeField({ label, name, value, min = 0 }: { label: string; name: string; value: number; min?: number }) {
  return <label>{label}<input type="number" name={name} min={min} max={300} step={0.001} required defaultValue={seconds(value)} /></label>;
}

function AudioPicker({ track, choose, close }: { track: "music" | "sfx"; choose: (material: ComicMaterial) => void; close: () => void }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<ComicLibraryPage<ComicMaterial> | "error" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    void comicLibraryApi.materials({ kind: track === "music" ? "music" : "sound", query: search, page: String(page) }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setState(value); })
      .catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, [track, search, page]);
  return <div className="comic-track-picker">
    <div className="comic-actions">
      <label>{t("搜索音频素材")}<input value={search} maxLength={120} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label>
      <button type="button" onClick={close}>{t("取消")}</button>
    </div>
    {state === null ? <p role="status">{t("加载中…")}</p> : state === "error" ? <p role="alert">{t("操作失败，请重试")}</p> : <>
      {state.entries.length ? <ul>{state.entries.map(material => <li key={material.id}>
        <span>{material.name} · {t("{0} 秒", [seconds(material.media.durationMs ?? 0)])}</span>
        <button type="button" disabled={!material.media.durationMs} onClick={() => choose(material)}>{t("添加到轨道")}</button>
      </li>)}</ul> : <p>{t("素材库暂无此类音频")}</p>}
      <div className="comic-actions">
        <button type="button" disabled={page < 2} onClick={() => setPage(value => value - 1)}>{t("上一页")}</button>
        <button type="button" disabled={!state.more} onClick={() => setPage(value => value + 1)}>{t("下一页")}</button>
      </div>
    </>}
  </div>;
}

function CaptionStyleFields({ timeline, change }: {
  timeline: ComicTimeline; change: (style: NonNullable<ComicTimeline["captionStyle"]>) => void;
}) {
  const { t } = useI18n();
  const style = timeline.captionStyle ?? { size: "medium", position: "medium", color: "white" };
  return <div className="comic-caption-style">
    <label>{t("字幕字号")}<select value={style.size} onChange={e => change({ ...style, size: e.target.value as typeof style.size })}>
      <option value="small">{t("小")}</option><option value="medium">{t("中")}</option><option value="large">{t("大")}</option>
    </select></label>
    <label>{t("字幕位置")}<select value={style.position} onChange={e => change({ ...style, position: e.target.value as typeof style.position })}>
      <option value="low">{t("底部")}</option><option value="medium">{t("稍高")}</option><option value="high">{t("上移")}</option>
    </select></label>
    <label>{t("字幕颜色")}<select value={style.color} onChange={e => change({ ...style, color: e.target.value as typeof style.color })}>
      <option value="white">{t("白色")}</option><option value="yellow">{t("黄色")}</option><option value="black">{t("黑色")}</option>
      <option value="box">{t("白字底框")}</option><option value="yellow-box">{t("黄字底框")}</option>
    </select></label>
  </div>;
}

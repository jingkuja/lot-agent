import { useCallback, useEffect, useRef, useState } from "react";
import { comicTimelineSchema, comicVideoItem, layoutComicTimeline, type ComicEdit, type ComicEditSource, type ComicTimeline } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { ComicTrimmedPreview } from "./ComicTrimmedPreview.js";
import { ComicTimelineTracks } from "./ComicTimelineTracks.js";
import { ComicRenderPanel } from "./ComicRenderPanel.js";
import { ComicDialogueAudio } from "./ComicDialogueAudio.js";
import { ComicVideoHistory } from "./ComicVideoHistory.js";
import { comicEditApi, editError } from "./edit-api.js";
import { comicGenerationApi } from "./generation-api.js";
import { LibraryDialog } from "./LibraryParts.js";

type Video = ComicTimeline["video"][number];
type Editable = Pick<ComicEdit, "title" | "timeline">;
const seconds = (ms: number) => String(ms / 1000);

export function ComicEditWorkspace({ id, exit, openVideo, setGuard }: {
  id: string; exit: () => void; openVideo: (seriesId: string, clipId: string) => void; setGuard: (guard: (() => boolean) | null) => void;
}) {
  const { t } = useI18n();
  const [project, setProject] = useState<ComicEdit | null>(null);
  const [draft, setDraft] = useState<Editable | null>(null);
  const [extra, setExtra] = useState<ComicEditSource[]>([]);
  const [selected, setSelected] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savePaused, setSavePaused] = useState(false);
  const [picking, setPicking] = useState(false);
  const [replacement, setReplacement] = useState(false);
  const [position, setPosition] = useState(0);
  const [seek, setSeek] = useState({ ms: 0 });
  const pending = useRef(false);
  const dirty = !!project && !!draft && (draft.title !== project.title || draft.timeline !== project.timeline);
  const receive = (data: ComicEdit) => {
    setProject(data);
    setDraft({ title: data.title, timeline: data.timeline });
    setExtra([]);
    setSavePaused(false);
  };
  useEffect(() => {
    setGuard(() => !pending.current && (!dirty || window.confirm(t("放弃未保存的工程修改？"))));
    return () => setGuard(null);
  }, [dirty, setGuard, t]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  useEffect(() => {
    const controller = new AbortController();
    void comicEditApi.get(id, controller.signal).then(data => {
      if (!controller.signal.aborted) { receive(data); setError(""); }
    }).catch(error => { if (!controller.signal.aborted) setError(editError(error)); });
    return () => controller.abort();
  }, [id, attempt]);

  const reload = () => {
    if (pending.current || (dirty && !window.confirm(t("放弃未保存的工程修改？")))) return;
    setAttempt(value => value + 1);
  };
  const run = useCallback(async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try { await work(); }
    catch (error) { setError(editError(error)); }
    finally { pending.current = false; setSaving(false); }
  }, []);
  const save = useCallback(() => {
    if (!project || !draft || !dirty || !draft.title.trim()) return;
    void run(async () => {
      try {
        receive(await comicEditApi.update(id, { title: draft.title, timeline: draft.timeline, expectedRevision: project.revision }));
      } catch (error) {
        setSavePaused(true);
        throw error;
      }
    });
  }, [draft, dirty, id, project, run]);
  useEffect(() => {
    if (!dirty || saving || savePaused || picking || replacement) return;
    const timer = setTimeout(save, 850);
    return () => clearTimeout(timer);
  }, [dirty, picking, replacement, save, savePaused, saving]);
  const apply = (value: ComicTimeline) => {
    const valid = comicTimelineSchema.safeParse(value);
    if (!valid.success) { setError("请检查时间线中的裁切和素材"); return; }
    setError("");
    setDraft(previous => previous && { ...previous, timeline: valid.data });
  };
  const choose = (takeId: string) => void run(async () => {
    const take = await comicGenerationApi.videoTake(takeId);
    if (!draft || !take.mediaId || take.durationMs <= 0) return;
    const added = comicVideoItem(crypto.randomUUID(), { takeId, durationMs: take.durationMs });
    setExtra(values => [...values, { takeId, mediaId: take.mediaId!, version: take.version, durationMs: take.durationMs,
      seriesTitle: take.seriesTitle, aspectRatio: draft.timeline.aspectRatio, clipId: take.targetId, scene: take.scene, adopted: null }]);
    apply({ ...draft.timeline, video: [...draft.timeline.video, added] });
    setSelected(added.id);
    setPicking(false);
  });

  if (!project || !draft) return error ? <div className="comic-error" role="alert">
    {t(error)} <button type="button" onClick={reload}>{t("重新读取")}</button>
  </div> : <p role="status">{t("加载中…")}</p>;
  const timeline = draft.timeline;
  const video = timeline.video;
  const item = video.find(item => item.id === selected) ?? video[0];
  const sources = [...project.sources, ...extra];
  const source = sources.find(source => source.takeId === item?.takeId);
  const adopted = source?.adopted;
  const layout = layoutComicTimeline(timeline);
  const locate = (ms: number) => { setPosition(ms); setSeek({ ms }); };
  const normalizeFirst = (entries: Video[]) => entries.map((entry, index) =>
    index === 0 && entry.transitionIn.kind !== "cut" ? { ...entry, transitionIn: { kind: "cut" as const, durationMs: 0 as const } } : entry);
  const move = (from: number, step: number) => {
    const next = [...video];
    [next[from], next[from + step]] = [next[from + step], next[from]];
    apply({ ...timeline, video: normalizeFirst(next) });
  };
  const remove = (target: Video) => {
    const remaining = <T extends { anchor: ComicTimeline["voice"][number]["anchor"] }>(items: T[]) =>
      items.filter(entry => entry.anchor.kind !== "clip" || entry.anchor.videoItemId !== target.id);
    const next = { ...timeline, video: normalizeFirst(video.filter(item => item.id !== target.id)), voice: remaining(timeline.voice),
      sfx: remaining(timeline.sfx), music: remaining(timeline.music), subtitles: remaining(timeline.subtitles) };
    if (next.voice.length + next.sfx.length + next.music.length + next.subtitles.length <
      timeline.voice.length + timeline.sfx.length + timeline.music.length + timeline.subtitles.length &&
      !window.confirm(t("移除片段及其配音和依附素材？"))) return;
    apply(next);
  };

  return <>
    <header className="comic-heading">
      <div><h1>{project.title}</h1><small role="status">{t(saving ? "保存中…" : dirty ? "未保存" : "已保存")}</small></div>
      <div className="comic-actions">
        <button type="button" onClick={exit}>{t("返回剪辑工程列表")}</button>
        <button type="button" onClick={reload} disabled={saving}>{t("重新读取工程")}</button>
        <button type="button" className="primary" disabled={!dirty || !draft.title.trim() || saving} onClick={save}>{t("保存工程")}</button>
      </div>
    </header>
    {error && <p className="comic-error" role="alert">{t(error)}</p>}
    {picking ? <>
      <button type="button" disabled={saving} onClick={() => setPicking(false)}>{t("返回时间线")}</button>
      <ComicVideoHistory picker open={openVideo} choose={choose} />
    </> : <>
      <div className="comic-edit-grid">
        <ComicTrimmedPreview timeline={timeline} sources={sources} seek={seek} position={position} onPosition={setPosition} />
        <section className="comic-edit-card">
          <header><h2>{t("视频轨")}</h2><strong>{t("总时长 {0} 秒", [seconds(layout.durationMs)])}</strong></header>
          <fieldset disabled={saving} className="comic-editor-fields">
            <label>{t("工程名称")}<input value={draft.title} maxLength={120} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
            <div className="comic-actions"><button type="button" onClick={() => setPicking(true)} disabled={video.length >= 200}>{t("添加片源")}</button></div>
            <ol className="comic-video-track">{video.map((entry, index) => {
              const meta = sources.find(source => source.takeId === entry.takeId);
              return <li key={entry.id}>
                <button className="comic-track-label" type="button" aria-pressed={item?.id === entry.id} onClick={() => setSelected(entry.id)}>
                  <strong>{meta?.scene || meta?.seriesTitle || t("片源不可用，请重新选择")}</strong>
                  <small>{meta?.seriesTitle} · {t("版本 {0}", [meta?.version ?? "—"])} · {seconds(entry.outMs - entry.inMs)} s</small>
                </button>
                <div className="comic-actions">
                  <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>{t("上移")}</button>
                  <button type="button" disabled={index + 1 === video.length} onClick={() => move(index, 1)}>{t("下移")}</button>
                  <button type="button" onClick={() => remove(entry)}>{t("移除")}</button>
                </div>
              </li>;
            })}</ol>
            {item && <TrimFields key={item.id + ":" + item.inMs + ":" + item.outMs + ":" + item.takeId} item={item}
              apply={(inMs, outMs) => apply({ ...timeline, video: video.map(entry => entry.id === item.id ? { ...entry, inMs, outMs } : entry) })} />}
            {item && <VideoProperties key={JSON.stringify(item)} item={item} first={video[0]?.id === item.id}
              change={next => apply({ ...timeline, video: video.map(entry => entry.id === item.id ? next : entry) })} />}
            {item && adopted && adopted.takeId !== item.takeId && <div className="comic-actions">
              <button type="button" disabled={dirty} onClick={() => setReplacement(true)}>{t("替换为采用版（版本 {0}）", [adopted.version])}</button>
              {dirty && <small>{t("保存工程后可替换片源")}</small>}
            </div>}
          </fieldset>
        </section>
      </div>
      <ComicTimelineTracks timeline={timeline} videoSources={sources} audioSources={project.audioSources ?? []} selectedVideo={item?.id}
        positionMs={position} seek={locate} selectVideo={setSelected} update={apply} disabled={saving} />
      {item && project.timeline.video.some(saved => saved.id === item.id && saved.takeId === item.takeId) &&
        <ComicDialogueAudio key={item.id + item.takeId} projectId={id} revision={project.revision} item={item} voice={timeline.voice}
          change={voice => apply({ ...timeline, voice })} subtitles={timeline.subtitles}
          addSubtitle={cue => apply({ ...timeline, subtitles: [...timeline.subtitles, cue] })} disabled={saving} />}
      <ComicRenderPanel project={project} dirty={dirty || saving} />
    </>}
    {replacement && item && adopted && <LibraryDialog title={t("替换为采用版（版本 {0}）", [adopted.version])} submitLabel={t("确认替换")}
      close={() => setReplacement(false)} describeError={editError} save={async (form, signal) => {
        const outMs = item.outMs > adopted.durationMs ? Math.round(Number(form.get("out")) * 1000) : item.outMs;
        receive(await comicEditApi.replace(id, item.id, { expectedRevision: project.revision, takeId: adopted.takeId, outMs }, signal));
      }}>
      {item.outMs > adopted.durationMs ? <>
        <p>{t("新版短于当前出点。请确认新的出点。")}</p>
        <label>{t("出点（秒）")}<input name="out" type="number" min={(item.inMs + 1) / 1000} max={adopted.durationMs / 1000}
          step={0.001} required defaultValue={seconds(adopted.durationMs)} /></label>
      </> : <p>{t("替换后保留当前入点和出点。")}</p>}
    </LibraryDialog>}
  </>;
}

function VideoProperties({ item, first, change }: { item: Video; first: boolean; change: (item: Video) => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState(item.transitionIn.kind);
  return <form className="comic-overlay-fields" onSubmit={event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const transitionIn: Video["transitionIn"] = kind === "cut" || first ? { kind: "cut", durationMs: 0 }
      : { kind, durationMs: Math.round(Number(form.get("transition")) * 1000) };
    change({ ...item, transitionIn, volume: Number(form.get("volume")) / 100 });
  }}>
    {!first && <label>{t("入场转场")}<select aria-label={t("入场转场")} value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
      <option value="cut">{t("直接切换")}</option><option value="crossfade">{t("交叠淡入淡出")}</option><option value="black">{t("黑场过渡")}</option>
    </select></label>}
    {!first && kind !== "cut" && <label>{t("转场（秒）")}<input type="number" name="transition" min={0.001}
      max={(item.outMs - item.inMs - 1) / 1000} required step={0.001} defaultValue={item.transitionIn.durationMs / 1000 || 0.5} /></label>}
    <label>{t("片源音量（%）")}<input type="number" name="volume" min={0} max={200} required defaultValue={Math.round(item.volume * 100)} /></label>
    <button type="submit">{t("应用片段设置")}</button>
  </form>;
}

function TrimFields({ item, apply }: { item: Video; apply: (inMs: number, outMs: number) => void }) {
  const { t } = useI18n();
  return <form className="comic-trim-controls" onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    apply(Math.round(Number(data.get("in")) * 1000), Math.round(Number(data.get("out")) * 1000));
  }}>
    <label>{t("入点（秒）")}<input name="in" type="number" required min={0} max={(item.sourceDurationMs - 1) / 1000}
      step={0.001} defaultValue={seconds(item.inMs)} /></label>
    <label>{t("出点（秒）")}<input name="out" type="number" required min={0.001} max={item.sourceDurationMs / 1000}
      step={0.001} defaultValue={seconds(item.outMs)} /></label>
    <button type="submit">{t("应用裁切")}</button>
  </form>;
}

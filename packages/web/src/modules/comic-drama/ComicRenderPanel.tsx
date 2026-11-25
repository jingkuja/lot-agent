import { useEffect, useRef, useState } from "react";
import {
  comicRenderIssue, type ComicEdit, type ComicRender, type ComicRenderFps, type ComicRenderFpsMode, type ComicRenderHistory,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { ApiClientError } from "../../api/client.js";
import { comicEditApi, comicRenderError, editError } from "./edit-api.js";

const active = (render: ComicRender) => render.status === "pending" || render.status === "running";

export function ComicRenderPanel({ project, dirty = false }: { project?: ComicEdit; dirty?: boolean }) {
  const { t, locale } = useI18n();
  const [history, setHistory] = useState<ComicRenderHistory>();
  const [cursors, setCursors] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<{ id: string; url: string }>();
  const [pending, setPending] = useState<string | null>(null);
  const [fpsMode, setFpsMode] = useState<ComicRenderFpsMode>("auto");
  const running = useRef(false);
  const removed = useRef(new Set<string>());
  const player = useRef<HTMLVideoElement>(null);
  const request = useRef<{ revision: number; fpsMode: ComicRenderFpsMode; requestId: string }>(null);
  const targetFps: ComicRenderFps = fpsMode === "24" ? 24 : 30;
  const issue = project ? comicRenderIssue(project.timeline, targetFps) : null;
  const edit = project?.id;
  const cursor = cursors.at(-1);
  const reload = () => setRefresh(value => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await comicEditApi.renders(edit, cursor, controller.signal);
        if (controller.signal.aborted) return;
        setHistory({ ...result, entries: result.entries.filter(render => !removed.current.has(render.id)) });
        setLoadError(false);
        if (result.entries.some(active)) timer = setTimeout(poll, 1800);
      } catch { if (!controller.signal.aborted) setLoadError(true); }
    };
    void poll();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [edit, cursor, refresh]);

  const action = async (key: string, run: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setPending(key); setMessage("");
    try { await run(); }
    catch (error) { setMessage(editError(error)); }
    finally { running.current = false; setPending(null); }
  };
  const submit = () => void action("submit", async () => {
    if (!project || dirty || issue) return;
    const nonce = request.current?.revision === project.revision && request.current?.fpsMode === fpsMode
      ? request.current
      : { revision: project.revision, fpsMode, requestId: crypto.randomUUID() };
    request.current = nonce;
    try {
      await comicEditApi.startRender(project.id, { expectedRevision: nonce.revision, requestId: nonce.requestId, fpsMode: nonce.fpsMode });
      request.current = null;
      setCursors([]);
      reload();
    } catch (error) {
      if (error instanceof ApiClientError && error.status < 500) request.current = null;
      throw error;
    }
  });
  const control = (render: ComicRender, operation: "cancel" | "recover") => void action(render.id, async () => {
    if (operation === "cancel" && !window.confirm(t("取消这次导出？"))) return;
    const next = await comicEditApi.renderControl(render.id, operation);
    setHistory(current => current && { ...current, entries: current.entries.map(row => row.id === next.id ? next : row) });
    reload();
  });
  const play = (render: ComicRender) => void action(render.id, async () => {
    const { url } = await comicEditApi.downloadRender(render.id, true);
    setPreview({ id: render.id, url });
  });
  const download = (render: ComicRender) => void action(render.id, async () => {
    const result = await comicEditApi.downloadRender(render.id);
    const link = document.createElement("a");
    link.href = result.url;
    link.download = result.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  });
  const remove = (render: ComicRender) => void action(render.id, async () => {
    if (!window.confirm(t("删除导出修订 {0} 的成片？此操作无法撤销。", [render.editRevision]))) return;
    await comicEditApi.removeRender(render.id);
    removed.current.add(render.id);
    if (preview?.id === render.id) {
      player.current?.pause();
      player.current?.removeAttribute("src");
      player.current?.load();
      setPreview(undefined);
    }
    setHistory(current => current && { ...current, entries: current.entries.filter(row => row.id !== render.id) });
    if (cursor && history?.entries.length === 1) setCursors(values => values.slice(0, -1));
    reload();
  });
  return <section className="comic-edit-card comic-render-panel">
    <header>
      {project ? <h2>{t("合并导出")}</h2> : <h1>{t("导出历史")}</h1>}
      <div className="comic-actions">
        {project && (
          <label className="comic-render-fps">
            <span>{t("导出帧率")}</span>
            <select aria-label={t("导出帧率")} value={fpsMode} disabled={pending !== null}
              onChange={event => setFpsMode(event.target.value as ComicRenderFpsMode)}>
              <option value="auto">{t("自动（全 24 fps 原生导出，混帧转 30 fps）")}</option>
              <option value="24">{t("24 fps（漫剧原生帧率）")}</option>
              <option value="30">{t("30 fps（恒定帧率兼容）")}</option>
            </select>
          </label>
        )}
        <button type="button" onClick={reload}>{t("重新读取导出状态")}</button>
        {project && <button type="button" className="primary" onClick={submit} disabled={dirty || pending !== null || !!issue}>
          {t(pending === "submit" ? "正在提交…" : "导出 MP4")}
        </button>}
      </div>
    </header>
    <p className="comic-render-notice" role="note">{t("导出正片包含 AI 生成内容，发布至外部平台时请按平台规范标注“内容由 AI 生成”。")}</p>
    {project && (dirty ? <p>{t("保存当前修订后即可导出")}</p> : issue ? <p>{t(comicRenderError(issue))}</p> : null)}
    {message && <p role="alert" className="comic-error">{t(message)}</p>}
    {loadError && <p role="alert" className="comic-error">{t("导出历史暂时无法读取")}</p>}
    {!history && !loadError && <p role="status">{t("加载中…")}</p>}
    {history && (history.entries.length ? <ul className="comic-export-history">{history.entries.map(render => <li key={render.id} className="comic-render-result">
      <div>
        <strong>{render.title || t("未命名剪辑工程")}</strong>
        <small>
          {t("导出修订 {0}", [render.editRevision])} · {t("{0} 秒", [render.durationMs / 1000])}
          {render.outputFps ? ` · ${render.outputFps} fps` : ""} · {new Date(render.createdAt).toLocaleString(locale)}
        </small>
      </div>
      <span role="status">{t(render.status === "ready" ? "导出完成" : render.status === "pending" ? "等待合成" :
        render.status === "running" ? "正在合成" : render.status === "cancelled" ? "已取消" : comicRenderError(render.error ?? ""))}</span>
      <div className="comic-actions">
        {active(render) && <button type="button" disabled={pending !== null} onClick={() => control(render, "cancel")}>{t("取消导出")}</button>}
        {render.recoverable && <button type="button" disabled={pending !== null} onClick={() => control(render, "recover")}>{t("用原修订恢复")}</button>}
        {render.mediaId && <>
          <button type="button" disabled={pending !== null} onClick={() => play(render)}>{t("播放导出成片")}</button>
          <button type="button" disabled={pending !== null} onClick={() => download(render)}>{t("下载 MP4")}</button>
        </>}
        {render.status === "ready" && <button type="button" disabled={pending !== null} onClick={() => remove(render)}>{t("删除导出")}</button>}
      </div>
    </li>)}</ul> : <p>{t("暂无导出记录")}</p>)}
    {(cursor || history?.nextCursor) && <div className="comic-actions">
      <button type="button" disabled={!cursor || pending !== null} onClick={() => setCursors(values => values.slice(0, -1))}>{t("上一页")}</button>
      <button type="button" disabled={!history?.nextCursor || pending !== null} onClick={() => {
        if (history?.nextCursor) setCursors(values => [...values, history.nextCursor!]);
      }}>{t("下一页")}</button>
    </div>}
    {preview && <video ref={player} key={preview.url} src={preview.url} controls playsInline preload="metadata" aria-label={t("导出成片")}
      onError={() => { setPreview(undefined); if (!removed.current.has(preview.id)) setMessage("重新获取预览"); }} />}
  </section>;
}

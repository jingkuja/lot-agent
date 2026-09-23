import { useCallback, useEffect, useRef, useState } from "react";
import { knowledgeApi, type Collection, type Item, type Evidence, type Results } from "./api.js";
import "./knowledge.css";

const stateLabels: Record<string, string> = { pending: "等待处理", processing: "正在处理", ready: "可检索", failed: "处理失败", cancelled: "已取消" };
function locator(hit: Evidence) {
  const c = hit.citation;
  return c?.kind === "pdf" ? `第 ${c.page} 页` : c?.kind === "docx" ? `${c.heading ? `${c.heading} · ` : ""}第 ${c.paragraph} 段` : c?.kind === "text" ? `第 ${c.startLine}–${c.endLine} 行` : "资料说明";
}
export function KnowledgePanel({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionCursor, setCollectionCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [items, setItems] = useState<Item[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [name, setName] = useState(""); const [title, setTitle] = useState(""); const [body, setBody] = useState("");
  const [query, setQuery] = useState(""); const [mode, setMode] = useState("hybrid"); const [degraded, setDegraded] = useState(false);
  const [results, setResults] = useState<Results | null>(null); const [preview, setPreview] = useState<{ hit: Evidence; text: string | null; url?: string } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [enabled, setEnabled] = useState(false); const [tasks, setTasks] = useState<Record<string, { progress: number; error?: string }>>({});
  const selection = useRef(selected); selection.current = selected;
  const resultRef = useRef(results); resultRef.current = results;
  const mounted = useRef(true); const uploading = useRef(false);
  const report = (e: unknown) => setError(e instanceof Error ? e.message : "知识服务暂不可用");
  const loadCollections = useCallback(async () => {
    const page = await knowledgeApi.collections(); if (!mounted.current) return;
    setCollections(page.data); setCollectionCursor(page.nextCursor);
    setSelected((previous) => previous || page.data[0]?.id || "");
  }, []);
  const refresh = useCallback(async () => {
    if (!selected) return;
    const page = await knowledgeApi.items(selected);
    if (!mounted.current || selection.current !== selected) return;
    setItems(page.data); setCursor(page.nextCursor);
    const states = await Promise.all(page.data.filter((item) => item.taskId).map(async (item) => [item.id, await knowledgeApi.task(item.taskId!)] as const));
    if (mounted.current && selection.current === selected) setTasks(Object.fromEntries(states));
  }, [selected]);
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal();
    void loadCollections().catch(report); void knowledgeApi.status().then((status) => setEnabled(status.ingestionEnabled)).catch(report);
    const unload = (event: BeforeUnloadEvent) => { if (uploading.current) event.preventDefault(); };
    window.addEventListener("beforeunload", unload);
    return () => { mounted.current = false; window.removeEventListener("beforeunload", unload); };
  }, [loadCollections]);
  useEffect(() => { setItems([]); setCursor(null); setResults(null); setPreview(null); setError(""); void refresh().catch(report); }, [refresh]);
  useEffect(() => {
    let closed = false; let timer: ReturnType<typeof setTimeout>; let delay = 3000;
    const poll = async () => {
      try {
        if (items.some((item) => ["pending", "processing"].includes(item.indexStatus))) await refresh();
        const previous = resultRef.current;
        if (previous) {
          const current = await Promise.all(previous.results.map((hit) => knowledgeApi.item(hit.itemId)));
          if (current.some((item, n) => item.activeRevisionId !== previous.results[n].revisionId || !item.collectionIds.includes(selected))) { setResults(null); setPreview(null); setNotice("资料已更新，请重新检索。"); }
        }
        delay = 3000;
      } catch (e) { setResults(null); setPreview(null); report(e); delay = Math.min(delay * 2, 30000); }
      if (!closed) timer = setTimeout(() => void poll(), delay);
    };
    timer = setTimeout(() => void poll(), delay);
    return () => { closed = true; clearTimeout(timer); };
  }, [items, refresh, selected]);
  async function act(work: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice(""); setResults(null); setPreview(null);
    try { await work(); await refresh(); await loadCollections(); } catch (e) { report(e); } finally { setBusy(false); }
  }
  async function showSource(hit: Evidence) {
    setError(""); setPreview(null);
    try {
      const item = await knowledgeApi.item(hit.itemId);
      if (item.activeRevisionId !== hit.revisionId || !item.collectionIds.includes(selected)) { setResults(null); throw new Error("引用已失效，请重新检索。"); }
      // A pending replacement must not be presented as the cited active revision.
      const text = item.revisionId === hit.revisionId ? item.content : null;
      const url = item.mime ? (await knowledgeApi.ticket(hit.itemId, hit.revisionId)).url : undefined;
      setPreview({ hit, text, url });
    } catch (e) { report(e); }
  }
  const close = () => { if (!busy) onClose(); };
  return <dialog ref={dialog} className="knowledge-dialog" onCancel={(event) => { event.preventDefault(); close(); }} aria-labelledby="knowledge-title">
    <header className="knowledge-head"><div><h2 id="knowledge-title">本地知识库</h2><p>保存资料，检索片段，查看出处</p></div><button onClick={close} disabled={busy} aria-label="关闭知识库">关闭</button></header>
    {error && <p className="knowledge-message" role="alert">{error}</p>}{notice && <p className="knowledge-message" role="status">{notice}</p>}
    {!enabled && <p className="knowledge-message">当前仅保存资料，后台索引尚未启用。</p>}
    <div className="knowledge-layout"><aside className="knowledge-libraries">
      <form onSubmit={(e) => { e.preventDefault(); void act(async () => { const created = await knowledgeApi.createCollection(name.trim()); setName(""); setSelected(created.id); }); }}>
        <label>新建知识库<input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="例如：产品资料" required /></label><button disabled={busy || !name.trim()}>创建</button>
      </form>
      <nav aria-label="知识库列表">{collections.map((collection) => <button key={collection.id} aria-current={selected === collection.id ? "page" : undefined} onClick={() => setSelected(collection.id)} disabled={busy}><strong>{collection.name}</strong><small>{collection.storedCount} 份资料 · {collection.searchableCount} 份可检索</small></button>)}</nav>
      {collectionCursor && <button disabled={busy} onClick={() => void knowledgeApi.collections(collectionCursor).then((page) => { setCollections((old) => [...old, ...page.data]); setCollectionCursor(page.nextCursor); }).catch(report)}>更多知识库</button>}
    </aside><main className="knowledge-main">
      {!selected ? <p>创建一个知识库，即可添加资料。</p> : <>
        <h3>{collections.find((collection) => collection.id === selected)?.name ?? "当前知识库"}</h3>
        <details className="knowledge-collect"><summary>添加资料或粘贴文字</summary>
          <label>上传文件<input type="file" accept=".txt,.md,.pdf,.docx" multiple disabled={busy} onChange={(event) => {
            const files = Array.from(event.target.files ?? []); event.target.value = "";
            void act(async () => { uploading.current = true; let success = 0; const failures: string[] = [];
              try { for (const file of files) { try { await knowledgeApi.upload(selected, file); success++; } catch (e) { failures.push(`${file.name}：${e instanceof Error ? e.message : "上传失败"}`); } } }
              finally { uploading.current = false; }
              setNotice(`已保存 ${success} 个文件。${failures.join("；")}`);
            });
          }} /></label>
          <form onSubmit={(e) => { e.preventDefault(); void act(async () => { await knowledgeApi.note(selected, title.trim(), body); setTitle(""); setBody(""); }); }}>
            <label>笔记标题<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} required /></label>
            <label>正文<textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={200000} rows={5} required /></label><button disabled={busy || !title.trim() || !body.trim()}>保存笔记</button>
          </form>
        </details>
        <section aria-label="库内检索"><form className="knowledge-search" onSubmit={(e) => { e.preventDefault(); const current = selected; setBusy(true); setError(""); setResults(null); setPreview(null); void knowledgeApi.search(current, query, mode, degraded).then((value) => { if (selection.current === current) setResults(value); }).catch(report).finally(() => setBusy(false)); }}>
          <label>在当前知识库中检索<input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={2000} placeholder="输入问题或关键词" required /></label>
          <label>检索方式<select value={mode} onChange={(e) => setMode(e.target.value)}><option value="hybrid">混合检索</option><option value="keyword">关键词</option><option value="semantic">语义检索</option></select></label>
          <button disabled={busy || !enabled || !query.trim()}>检索</button>
          <label className="knowledge-checkbox"><input type="checkbox" checked={degraded} onChange={(e) => setDegraded(e.target.checked)} />语义服务不可用时允许关键词检索</label>
        </form>
        {results && <div className="knowledge-results" aria-live="polite">{results.degraded && <p>语义服务暂不可用，本次使用关键词检索。</p>}{!results.results.length && <p>当前范围内没有命中资料。</p>}{results.results.map((hit) => <article key={hit.chunkId}><h4>{hit.title}</h4><small>{hit.sourceType === "note" ? "笔记" : "资料"} · {locator(hit)}{hit.origin === "manual_description" ? " · 来自手工说明" : ""}</small><p>{hit.content}</p><div className="knowledge-actions"><button onClick={() => void showSource(hit)}>查看出处</button><button onClick={() => void navigator.clipboard.writeText(hit.content).then(() => setNotice("已复制摘录")).catch(report)}>复制摘录</button></div></article>)}</div>}
        </section>
        <section aria-label="资料列表"><div className="knowledge-head"><h3>资料</h3><button disabled={busy} onClick={() => void refresh().catch(report)}>刷新</button></div>
          {!items.length && <p>暂无资料。</p>}{items.map((item) => <article className="knowledge-item" key={item.id}><div><strong>{item.title}</strong><p>{enabled ? stateLabels[item.indexStatus] ?? item.indexStatus : "已保存"}{item.activeRevisionId && item.pendingRevisionId ? " · 旧版仍可检索" : ""}{item.indexStatus === "processing" ? ` · ${tasks[item.id]?.progress ?? 0}%` : ""}</p>{item.indexStatus === "failed" && tasks[item.id]?.error && <small>错误代码：{tasks[item.id].error}</small>}</div><div className="knowledge-actions">
            {enabled && ["failed", "cancelled"].includes(item.indexStatus) && <button disabled={busy} onClick={() => void act(() => knowledgeApi.retry(item))}>重试</button>}
            {enabled && ["pending", "processing"].includes(item.indexStatus) && item.taskId && <button disabled={busy} onClick={() => void act(() => knowledgeApi.cancel(item.taskId!))}>取消</button>}
            <button disabled={busy} onClick={() => { if (window.confirm(`删除“${item.title}”？将从关联的所有知识库中移除。`)) void act(() => knowledgeApi.remove(item)); }}>删除</button></div></article>)}
          {cursor && <button disabled={busy} onClick={() => void knowledgeApi.items(selected, cursor).then((page) => { setItems((old) => [...old, ...page.data]); setCursor(page.nextCursor); }).catch(report)}>加载更多资料</button>}
        </section>
      </>}
      {busy && <p role="status">正在处理，请稍候…</p>}
      {preview && <section className="knowledge-preview" aria-label="引用出处"><div className="knowledge-head"><h3>{preview.hit.title} · {locator(preview.hit)}</h3><button onClick={() => setPreview(null)}>收起</button></div><pre>{preview.text ?? preview.hit.content}</pre>{preview.url && <a href={`${preview.url}${preview.hit.citation?.kind === "pdf" ? `#page=${preview.hit.citation.page}` : ""}`} target="_blank" rel="noreferrer">打开原件{preview.hit.citation?.kind === "pdf" ? `第 ${preview.hit.citation.page} 页` : ""}</a>}</section>}
    </main></div>
  </dialog>;
}

import { MaterialThumbnail } from "./MaterialThumbnail.js";
import { PreviewDialog } from "./PreviewDialog.js";
import { Diagnostics, SourcePreview, locator, type Preview } from "./SourcePreview.js";
import { MaterialPreview } from "./MaterialPreview.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { DuplicateFileError, knowledgeApi, type Collection, type Item, type Evidence, type Results, type Material } from "./api.js";
import { ProfilePanel } from "./ProfilePanel.js";
import "./knowledge.css";

const types: Record<string, string> = { document: "文档", note: "笔记", bookmark: "书签", image: "图片", audio: "音频", video: "视频", profile_fact: "个人信息" };
const states: Record<string, string> = { pending: "等待处理", processing: "正在处理", ready: "可检索", failed: "处理失败", cancelled: "已取消", stored_only: "已保存，补充说明后可检索" };
const accept = ".txt,.md,.pdf,.docx,.png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,.m4a,.mp4,.webm";
const tags = (value: string) => [...new Set(value.split(/[,，]/).map((v) => v.trim()).filter(Boolean))];
const library = (scope: string) => !["inbox", "all", "profile", "materials"].includes(scope) ? scope : "";
const navigation = [
  { id: "inbox", label: "收件箱", path: "M4 4h16v16H4z M4 13h5l2 3h2l2-3h5" },
  { id: "all", label: "全部资料 / 搜索", path: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6" },
  { id: "profile", label: "个人信息", path: "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 21v-2a8 8 0 0 1 16 0v2" },
  { id: "materials", label: "个人素材", path: "M3 4h18v16H3z M3 16l5-5 4 4 3-3 6 6 M16 8h.01" },
];
function KnowledgeIcon({ path }: { path: string }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
interface Upload { id: string; file: File; progress: number; status: "waiting" | "uploading" | "saved" | "failed" | "duplicate"; error?: string; duplicate?: { id: string; title: string }; collections?: string[] }
export function KnowledgePanel({ onClose, onUse }: { onClose: () => void; onUse?: (file: File) => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const searchInput = useRef<HTMLInputElement>(null);
  const [collections, setCollections] = useState<Collection[]>([]); const [collectionCursor, setCollectionCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState("inbox"); const selection = useRef(selected); selection.current = selected;
  const [items, setItems] = useState<Item[]>([]); const itemsRef = useRef(items); itemsRef.current = items; const [cursor, setCursor] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]); const [target, setTarget] = useState("");
  const [name, setName] = useState(""); const [newLibrary, setNewLibrary] = useState(false);
  const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [kind, setKind] = useState("note"); const [url, setUrl] = useState("");
  const [query, setQuery] = useState(""); const [mode, setMode] = useState("hybrid"); const [degraded, setDegraded] = useState(false);
  const [type, setType] = useState(""); const [tag, setTag] = useState(""); const [filter, setFilter] = useState("");
  const [results, setResults] = useState<Results | null>(null); const [preview, setPreview] = useState<Preview | null>(null);
  const [editing, setEditing] = useState<Item | null>(null); const [editingCollection, setEditingCollection] = useState<Collection | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [enabled, setEnabled] = useState(false); const [bytes, setBytes] = useState(0); const [tasks, setTasks] = useState<Record<string, { progress: number; error?: string }>>({});
  const [uploads, setUploads] = useState<Upload[]>([]); const uploading = useRef(false);
  const [materials, setMaterials] = useState<Material[]>([]); const [materialMore, setMaterialMore] = useState(false); const [materialSource, setMaterialSource] = useState("");
  const [materialView, setMaterialView] = useState<"list" | "grid">("grid");
  const [materialPreview, setMaterialPreview] = useState<Material | null>(null);
  const mounted = useRef(true); const requestGeneration = useRef(0);
  const report = (e: unknown) => setError(e instanceof Error ? e.message : "知识服务暂不可用");
  const loadCollections = useCallback(async () => {
    const page = await knowledgeApi.collections(); if (!mounted.current) return;
    // Retain previously paged libraries during task polling and actions.
    setCollections((old) => [...page.data, ...old.filter((c) => !page.data.some((n) => n.id === c.id))]); setCollectionCursor(page.nextCursor);
    const storage = await knowledgeApi.storage(); if (mounted.current) setBytes(storage.storedBytes);
  }, []);
  const refresh = useCallback(async (preserve = false) => {
    if (selection.current !== selected) return;
    const generation = ++requestGeneration.current;
    if (selected === "profile") return;
    if (selected === "materials") {
      const [page, privatePage] = await Promise.all([knowledgeApi.materials(undefined, undefined, type, materialSource, tag, filter), knowledgeApi.items("all", undefined, type, tag, filter, materialSource)]);
      if (generation !== requestGeneration.current) return;
      setMaterials(page.data); setMaterialMore(page.data.length === 30); setItems(privatePage.data); setCursor(privatePage.nextCursor); return;
    }
    const page = await knowledgeApi.items(selected, undefined, type, tag, filter);
    const previous = preserve ? itemsRef.current.filter((item) => !page.data.some((i) => i.id === item.id)) : [];
    const extra = await Promise.all(previous.map((i) => knowledgeApi.item(i.id).catch(() => null)));
    if (!mounted.current || generation !== requestGeneration.current) return;
    const stillMatches = (i: Item) => (!library(selected) || i.collectionIds.includes(selected)) && (selected !== "inbox" || !i.collectionIds.length) && (!type || i.sourceType === type) && (!tag || i.tags.includes(tag)) && (!filter || i.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
    setItems([...page.data, ...extra.filter((i): i is Item => !!i && stillMatches(i))]); if (!preserve || !previous.length) setCursor(page.nextCursor);
  }, [selected, type, tag, filter, materialSource]);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal(); void loadCollections().catch(report); void knowledgeApi.status().then((s) => setEnabled(s.ingestionEnabled)).catch(report);
    const unload = (event: BeforeUnloadEvent) => { if (uploading.current) event.preventDefault(); };
    const shortcut = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !(event.target instanceof HTMLElement && (event.target.closest("input,textarea,select,[contenteditable=true]")))) { event.preventDefault(); setSelected("all"); setTimeout(() => searchInput.current?.focus(), 0); } };
    window.addEventListener("beforeunload", unload); window.addEventListener("keydown", shortcut);
    return () => { mounted.current = false; requestGeneration.current++; window.removeEventListener("beforeunload", unload); window.removeEventListener("keydown", shortcut); };
  }, [loadCollections]);
  useEffect(() => { setItems([]); setChecked([]); setCursor(null); setResults(null); setPreview(null); setMaterialPreview(null); setEditing(null); setEditingCollection(null); setError(""); void refresh().catch(report); }, [refresh]);
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>; let delay = 4000;
    const poll = async () => {
      try {
        const active = itemsRef.current.filter((i) => i.taskId && ["pending", "processing"].includes(i.indexStatus));
        if (active.length) {
          const progress = await Promise.all(active.map(async (i) => [i.id, await knowledgeApi.task(i.taskId!)] as const));
          if (stopped) return; setTasks(Object.fromEntries(progress)); await refresh(true);
        }
        if (results) for (const hit of results.results) {
          const current = await knowledgeApi.item(hit.itemId);
          if (current.activeRevisionId !== hit.revisionId || (library(selected) && !current.collectionIds.includes(selected))) throw new Error("资料已更新，请重新检索。");
          if (current.sourceType === "profile_fact") await knowledgeApi.text(hit.itemId, hit.revisionId);
        }
        if (preview) {
          const current = await knowledgeApi.item(preview.item.id);
          if (![current.activeRevisionId, current.pendingRevisionId].includes(preview.revision) || (library(selected) && !current.collectionIds.includes(selected))) throw new Error("原文已更新或移出当前范围，请重新打开。");
          if (current.sourceType === "profile_fact") await knowledgeApi.text(current.id, preview.revision);
        }
        delay = 4000;
      } catch (e) { if (!stopped) { setResults(null); setPreview(null); report(e); delay = Math.min(delay * 2, 30000); } }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }; timer = setTimeout(() => void poll(), 4000); return () => { stopped = true; clearTimeout(timer); };
  }, [refresh, selected, results, preview]);
  async function act(work: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice(""); setResults(null); setPreview(null);
    try { await work(); await refreshRef.current(true); await loadCollections(); } catch (e) { report(e); } finally { setBusy(false); }
  }
  function pick(files: File[]) {
    const available = Math.max(0, 20 - uploads.filter((u) => u.status !== "saved").length);
    if (files.length > available) setNotice("每批最多 20 个文件，请完成当前批次后继续。");
    setUploads((old) => [...old.filter((u) => u.status !== "saved"), ...files.slice(0, available).map((file) => ({ id: crypto.randomUUID(), file, progress: 0, status: "waiting" as const }))]);
    if (!name && files[0]) setName(files[0].name.replace(/\.[^.]+$/, "").slice(0, 100));
  }
  const patchUpload = (id: string, update: Partial<Upload>) => setUploads((old) => old.map((u) => u.id === id ? { ...u, ...update } : u));
  async function uploadBatch(batch: Upload[], copy = false) {
    await act(async () => {
      uploading.current = true;
      try {
        let scope = library(selected);
        if (newLibrary) { const created = await knowledgeApi.createCollection(name.trim()); scope = created.id; setNewLibrary(false); setSelected(scope); }
        for (const entry of batch) {
          const ids = entry.collections ?? (scope ? [scope] : []); patchUpload(entry.id, { status: "uploading", collections: ids, error: undefined });
          try { await knowledgeApi.upload(ids, entry.file, entry.id, (progress) => patchUpload(entry.id, { progress }), copy); patchUpload(entry.id, { status: "saved", progress: 100 }); }
          catch (e) { patchUpload(entry.id, e instanceof DuplicateFileError ? { status: "duplicate", duplicate: e.duplicate } : { status: "failed", error: e instanceof Error ? e.message : "上传失败" }); }
        }
        setNotice("批次已处理。已保存文件的后台处理会继续，可关闭面板。");
      } finally { uploading.current = false; }
    });
  }
  async function showSource(item: Item, hit?: Evidence) {
    setError(""); setPreview(null); const scope = selected;
    try {
      const current = await knowledgeApi.item(item.id); const revision = hit?.revisionId ?? current.revisionId;
      if (hit && (current.activeRevisionId !== revision || (library(scope) && !current.collectionIds.includes(scope)))) { setResults(null); throw new Error("引用已失效，请重新检索。"); }
      const source = await knowledgeApi.text(item.id, revision);
      const url = current.size > 0 ? (await knowledgeApi.ticket(item.id, revision)).url : undefined;
      if (selection.current === scope) setPreview({ item: current, revision, source, hit, url });
    } catch (e) { report(e); }
  }
  async function useItem(item: Item) { await act(async () => { if (!onUse) return; const file = item.size ? await knowledgeApi.file(item) : new File([item.content ?? item.description], `${item.title}.txt`, { type: "text/plain" }); onUse(file); }); }
  const close = () => { if (!busy) onClose(); };
  const collection = collections.find((c) => c.id === selected);
  return <dialog ref={dialog} className="knowledge-dialog" onCancel={(event) => { event.preventDefault(); close(); }} aria-labelledby="knowledge-title">
    <header className="knowledge-head knowledge-header"><div className="knowledge-brand"><span className="knowledge-brand-icon"><KnowledgeIcon path="M4 3h14a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2 M3 18a3 3 0 0 1 3-3h14 M8 7h7 M8 10h5" /></span><div><h2 id="knowledge-title">个人知识库</h2><p>保存有用的资料，让每次对话都有据可循</p></div></div><div className="knowledge-header-actions"><span className="knowledge-storage">已存储 {(bytes / 1024 / 1024).toFixed(1)} MB</span><button className="knowledge-close" onClick={close} disabled={busy} aria-label="关闭知识库">×</button></div></header>
    {error && <p className="knowledge-message" role="alert">{error}</p>}{notice && <p className="knowledge-message" role="status">{notice}</p>}
    {!enabled && <p className="knowledge-message">当前仅保存资料，后台索引尚未启用。</p>}
    <div className="knowledge-layout"><aside className="knowledge-libraries"><nav aria-label="知识导航">
      <span className="knowledge-nav-caption">我的空间</span>
      {navigation.map(({ id, label, path }) => <button className="knowledge-nav-item" key={id} aria-current={selected === id ? "page" : undefined} disabled={busy} onClick={() => setSelected(id)}><KnowledgeIcon path={path} /><span>{label}</span></button>)}
      <span className="knowledge-nav-caption knowledge-library-caption">我的知识库 <span>{collections.length}</span></span>
      {collections.map((c) => <button key={c.id} aria-current={selected === c.id ? "page" : undefined} disabled={busy} onClick={() => setSelected(c.id)}><strong>{c.name}</strong><small>{c.storedCount} 份保存 · {c.searchableCount} 份可检索</small></button>)}
    </nav><button className="knowledge-create-library" disabled={busy} onClick={() => { setSelected("inbox"); setNewLibrary(true); }}><span aria-hidden="true">＋ </span>新建知识库</button>
      {collectionCursor && <button disabled={busy} onClick={() => void knowledgeApi.collections(collectionCursor).then((p) => { setCollections((old) => [...old, ...p.data.filter((c) => !old.some((i) => i.id === c.id))]); setCollectionCursor(p.nextCursor); }).catch(report)}>更多知识库</button>}
      <small>搜索快捷键：⌘ / Ctrl + K</small>
    </aside><main className="knowledge-main">
      {selected === "profile" ? <ProfilePanel collections={collections} /> : <>
        <div className="knowledge-head knowledge-section-heading"><div><h3>{collection?.name ?? (selected === "inbox" ? "收件箱" : selected === "materials" ? "个人素材" : "全部资料")}</h3><p>{collection?.description || (selected === "inbox" ? "先收集，再整理。未加入知识库的资料都会保存在这里。" : selected === "materials" ? "集中管理图片、音频和视频，随时用于对话。" : "查找已保存的内容，检索相关片段与原文出处。")}</p></div>{collection && <button disabled={busy} onClick={() => setEditingCollection({ ...collection })}>编辑知识库</button>}</div>
        {editingCollection && <form className="knowledge-collect" onSubmit={(e) => { e.preventDefault(); void act(async () => { await knowledgeApi.updateCollection(editingCollection, editingCollection); setEditingCollection(null); }); }}><label>库名称<input required maxLength={100} value={editingCollection.name} onChange={(e) => setEditingCollection({ ...editingCollection, name: e.target.value })} /></label><label>说明<textarea maxLength={2000} value={editingCollection.description} onChange={(e) => setEditingCollection({ ...editingCollection, description: e.target.value })} /></label><label>标签（逗号分隔）<input defaultValue={editingCollection.tags.join(", ")} onBlur={(e) => setEditingCollection({ ...editingCollection, tags: tags(e.target.value) })} /></label><div className="knowledge-actions"><button disabled={busy}>保存库信息</button><button type="button" disabled={busy} onClick={() => { if (window.confirm("删除此知识库？资料会保留在全部资料中。")) void act(async () => { await knowledgeApi.deleteCollection(editingCollection); setCollections((old) => old.filter((c) => c.id !== editingCollection.id)); setSelected("inbox"); }); }}>删除库，保留资料</button></div></form>}
        {selected !== "materials" && <section className="knowledge-collect" aria-label="收集资料" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!busy) pick(Array.from(e.dataTransfer.files)); }}>
          <label className={`knowledge-dropzone${busy ? " disabled" : ""}`}>
            <input aria-label="选择文件，或拖放到这里" type="file" accept={accept} multiple disabled={busy} onChange={(e) => { pick(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
            <span className="knowledge-upload-icon"><KnowledgeIcon path="M12 16V3 M7 8l5-5 5 5 M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></span>
            <strong>点击选择文件，或拖放到这里</strong>
            <span>支持 PDF、Word、文本及图片、音视频，每批最多 20 个文件</span>
            <span className="knowledge-upload-cta" aria-hidden="true">选择文件 <span>＋</span></span>
          </label>
          <label className="knowledge-checkbox"><input type="checkbox" checked={newLibrary} disabled={busy} onChange={(e) => setNewLibrary(e.target.checked)} />创建新知识库并导入</label>
          {newLibrary && <label>知识库名称<input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>}
          {uploads.map((u) => <article className="knowledge-item" key={u.id}><div><strong>{u.file.name}</strong><p>{({ waiting: "待上传", uploading: `上传 ${u.progress}%`, saved: "已保存，后台处理进度见资料列表", failed: u.error, duplicate: `已有资料：${u.duplicate?.title}` })[u.status]}</p>{u.status === "uploading" && <progress max={100} value={u.progress} />}</div>{u.status !== "uploading" && <button disabled={busy} onClick={() => setUploads((old) => old.filter((entry) => entry.id !== u.id))}>移除</button>}{u.status === "duplicate" && <div className="knowledge-actions"><button disabled={busy} onClick={() => void act(async () => { if (u.collections?.length) await knowledgeApi.memberships([u.duplicate!.id], u.collections, true); patchUpload(u.id, { status: "saved" }); })}>使用已有资料</button><button disabled={busy} onClick={() => void uploadBatch([u], true)}>保存独立副本</button></div>}</article>)}
          <div className="knowledge-actions"><button className="knowledge-primary" disabled={busy || (newLibrary && !name.trim()) || (!newLibrary && !uploads.some((u) => u.status === "waiting"))} onClick={() => void uploadBatch(uploads.filter((u) => u.status === "waiting"))}>{newLibrary ? "创建并导入" : "保存资料"}</button>{uploads.some((u) => u.status === "failed") && <button disabled={busy} onClick={() => void uploadBatch(uploads.filter((u) => u.status === "failed"))}>仅重试上传失败项</button>}</div>
          <details><summary>粘贴文字 / 添加书签</summary><form onSubmit={(e) => { e.preventDefault(); void act(async () => { await knowledgeApi.createItem({ sourceType: kind, title: title.trim(), ...(kind === "note" ? { content: body } : { sourceUrl: url, description: body }), collectionIds: library(selected) ? [selected] : [] }); setTitle(""); setBody(""); setUrl(""); }); }}><label>资料类型<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="note">笔记</option><option value="bookmark">书签（仅保存链接和说明）</option></select></label><label>标题<input required maxLength={255} value={title} onChange={(e) => setTitle(e.target.value)} /></label>{kind === "bookmark" && <label>网址<input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} /></label>}<label>{kind === "note" ? "正文" : "说明"}<textarea required={kind === "note"} maxLength={kind === "note" ? 200000 : 5000} rows={5} value={body} onChange={(e) => setBody(e.target.value)} /></label><button disabled={busy}>保存{kind === "note" ? "笔记" : "书签"}</button></form></details>
        </section>}
        <div className="knowledge-filters"><label>类型<select value={type} onChange={(e) => setType(e.target.value)}><option value="">全部类型</option>{Object.entries(types).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>标签<input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="精确标签" /></label><label>标题筛选<input placeholder="输入资料标题" value={filter} onChange={(e) => setFilter(e.target.value)} /></label></div>
        {selected === "materials" ? <section><p>旧素材归档会复制到私有空间，不会撤销原有分享链接；分享仍由原功能管理。媒体内容识别尚未启用，可编辑说明用于检索。</p><label>来源<select value={materialSource} onChange={(e) => setMaterialSource(e.target.value)}><option value="">全部来源</option><option value="upload">用户上传</option><option value="generated">Agent 生成</option><option value="archived">已归档</option></select></label><label>加入知识库<select value={target} onChange={(e) => setTarget(e.target.value)}><option value="">选择知识库</option>{collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <button onClick={() => setMaterialView((v) => v === "grid" ? "list" : "grid")}>{materialView === "grid" ? "列表视图" : "网格视图"}</button><div className={`knowledge-materials ${materialView}`}>
          {materials.map((m) => <article className="knowledge-item" key={m.id}><div><MaterialThumbnail material={m} onClick={() => setMaterialPreview(m)} /><strong>{m.original_name ?? `素材-${m.id}`}</strong><p>{m.mime} · {(Number(m.size_bytes) / 1024).toFixed(1)} KB{m.width && m.height ? ` · ${m.width} × ${m.height}` : ""}{m.duration_sec ? ` · ${Number(m.duration_sec).toFixed(1)} 秒` : ""} · {m.type === "upload" ? "上传" : "Agent 生成"} · {m.archived_item_id ? "已归档" : "未归档"}</p></div><div className="knowledge-actions"><button disabled={busy} onClick={() => void act(async () => { await knowledgeApi.archive(m, []); setNotice("已保存到私有个人素材。"); })}>保存个人素材</button><button disabled={busy || !target} onClick={() => void act(() => knowledgeApi.archive(m, [target]))}>加入知识库</button><button disabled={busy} onClick={() => setMaterialPreview(m)}>{m.mime.startsWith("image/") ? "查看原图" : "预览原件"}</button>{m.archived_item_id && <button disabled={busy} onClick={() => void knowledgeApi.item(m.archived_item_id!).then((i) => showSource(i)).catch(report)}>预览私有副本</button>}{onUse && <button disabled={busy} onClick={() => void act(async () => { onUse(await knowledgeApi.materialFile(m)); })}>用于当前对话</button>}</div></article>)}
          </div><h4>私有个人资料</h4>{items.map((i) => <article className="knowledge-item" key={i.id}><div><strong>{i.title}</strong><p>{types[i.sourceType]} · {i.materialSource === "generated" ? "Agent 生成" : "用户上传 / 私有保存"}{i.sourceAssetId ? " · 已归档" : ""} · {i.tags.join(" · ")}</p></div><div className="knowledge-actions"><button onClick={() => void showSource(i)}>预览</button><button disabled={busy || !target} onClick={() => void act(() => knowledgeApi.memberships([i.id], [target], true))}>加入知识库</button>{i.sourceType !== "profile_fact" && <button onClick={() => setEditing({ ...i })}>编辑说明</button>}{onUse && <button disabled={busy} onClick={() => void useItem(i)}>用于当前对话</button>}</div></article>)}
          {cursor && <button disabled={busy} onClick={() => void knowledgeApi.items("all", cursor, type, tag, filter, materialSource).then((p) => { setItems((old) => [...old, ...p.data]); setCursor(p.nextCursor); }).catch(report)}>更多私有资料</button>}
          {materialMore && <button disabled={busy} onClick={() => void knowledgeApi.materials(materials.at(-1)?.cursor_time, materials.at(-1)?.id, type, materialSource, tag, filter).then((p) => { setMaterials((old) => [...old, ...p.data]); setMaterialMore(p.data.length === 30); }).catch(report)}>更多素材</button>}
          <button onClick={() => { setSelected("all"); setType(""); }}>查看全部私有资料（支持标签筛选）</button>
        </section> : <>
        <section aria-label="资料检索"><form className="knowledge-search" onSubmit={(e) => { e.preventDefault(); const scope = selected; setBusy(true); setError(""); setResults(null); setPreview(null); void knowledgeApi.search(library(scope), query, mode, degraded, type, tag).then((value) => { if (selection.current === scope) setResults(value); }).catch(report).finally(() => setBusy(false)); }}>
          <label>{library(selected) ? "在当前知识库检索" : "搜索全部个人资料（含收件箱与有效个人信息）"}<input ref={searchInput} value={query} onChange={(e) => setQuery(e.target.value)} maxLength={2000} placeholder="输入问题或关键词" required /></label><label>方式<select aria-label="方式" value={mode} onChange={(e) => setMode(e.target.value)}><option value="hybrid">混合</option><option value="keyword">关键词</option><option value="semantic">语义</option></select></label><button className="knowledge-primary" disabled={busy || !enabled || !query.trim()}>检索</button><label className="knowledge-checkbox"><input type="checkbox" checked={degraded} onChange={(e) => setDegraded(e.target.checked)} />语义服务不可用时允许关键词检索</label>
        </form>{results && <div className="knowledge-results" aria-live="polite">{results.degraded && <p>语义服务暂不可用，本次使用关键词检索。</p>}{!results.results.length && <p>当前范围内没有命中资料。</p>}{results.results.map((hit) => <article key={hit.chunkId}><h4>{hit.title}</h4><small>{types[hit.sourceType]} · {locator(hit)}{hit.origin === "manual_description" ? " · 来自手工说明" : ""}</small><p>{hit.content}</p><div className="knowledge-actions"><button onClick={() => void knowledgeApi.item(hit.itemId).then((item) => showSource(item, hit)).catch(report)}>查看出处</button><button onClick={() => void (async () => { const current = await knowledgeApi.item(hit.itemId); if (current.activeRevisionId !== hit.revisionId || (library(selected) && !current.collectionIds.includes(selected))) { setResults(null); setPreview(null); throw new Error("引用已失效，请重新检索。"); } await knowledgeApi.text(hit.itemId, hit.revisionId); await navigator.clipboard.writeText(hit.content); setNotice("已复制摘录"); })().catch(report)}>复制摘录</button></div></article>)}</div>}</section>
        <section className="knowledge-documents" aria-label="资料列表"><div className="knowledge-head"><h3>资料 <span className="knowledge-count">{items.length}</span></h3><button disabled={busy} onClick={() => void refresh(true).catch(report)}>刷新</button></div><div className="knowledge-actions"><label className="knowledge-checkbox"><input type="checkbox" checked={items.length > 0 && checked.length === items.length} onChange={(e) => setChecked(e.target.checked ? items.map((i) => i.id) : [])} />选择本页已加载资料（{checked.length}）</label><select aria-label="批量目标知识库" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">选择知识库</option>{collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button disabled={busy || !checked.length || !target} onClick={() => void act(() => knowledgeApi.memberships(checked, [target], true))}>加入库</button>{library(selected) && <button disabled={busy || !checked.length} onClick={() => void act(async () => { await knowledgeApi.memberships(checked, [selected], false); setChecked([]); })}>移出当前库</button>}<button disabled={busy || !enabled || !items.some((i) => i.indexStatus === "failed")} onClick={() => void act(async () => { const failed = await Promise.allSettled(items.filter((i) => i.indexStatus === "failed").map((i) => knowledgeApi.retry(i))); setNotice(`已提交 ${failed.filter((r) => r.status === "fulfilled").length} 项重试；${failed.filter((r) => r.status === "rejected").length} 项未成功，请刷新后检查。`); })}>仅重试处理失败项</button></div>
          {!items.length && <div className="knowledge-empty"><KnowledgeIcon path="M4 3h16v18H4z M8 8h8 M8 12h8 M8 16h4" /><strong>还没有资料</strong><p>上传文件或粘贴文字，开始积累你的知识。</p></div>}{items.map((item) => <article className="knowledge-item" key={item.id}><label className="knowledge-checkbox"><input type="checkbox" checked={checked.includes(item.id)} onChange={(e) => setChecked((old) => e.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id))} /><span><strong>{item.title}</strong><p>{types[item.sourceType]} · {enabled ? states[item.indexStatus] ?? item.indexStatus : "已保存"}{item.activeRevisionId && item.pendingRevisionId ? " · 旧版仍可检索" : ""}{item.indexStatus === "processing" ? ` · ${tasks[item.id]?.progress ?? 0}%` : ""}</p><small>{item.tags.join(" · ")}{["image", "audio", "video"].includes(item.sourceType) ? " · 仅索引手工说明，未识别媒体内容" : ""}</small><Diagnostics warnings={item.diagnostics?.warnings} />{item.indexStatus === "failed" && <p>错误代码：{item.errorCode ?? tasks[item.id]?.error ?? "请重试或检查文件格式"}</p>}</span></label><div className="knowledge-actions"><button onClick={() => void showSource(item)}>查看</button>{item.sourceType !== "profile_fact" && <button disabled={busy} onClick={() => setEditing({ ...item })}>编辑 / 替换</button>}{onUse && <button disabled={busy} onClick={() => void useItem(item)}>用于当前对话</button>}{enabled && ["failed", "cancelled"].includes(item.indexStatus) && <button disabled={busy} onClick={() => void act(() => knowledgeApi.retry(item))}>重试</button>}{enabled && ["pending", "processing"].includes(item.indexStatus) && item.taskId && <button disabled={busy} onClick={() => void act(() => knowledgeApi.cancel(item.taskId!))}>取消</button>}{item.sourceType !== "profile_fact" && <button disabled={busy} onClick={() => { const names = item.collectionIds.map((id) => collections.find((c) => c.id === id)?.name ?? id).join("、"); if (window.confirm(`删除“${item.title}”？会从所有关联知识库中移除：${names || "无"}。`)) void act(() => knowledgeApi.remove(item)); }}>删除</button>}</div></article>)}
          {cursor && <button disabled={busy} onClick={() => { const scope = selected; void knowledgeApi.items(scope, cursor, type, tag, filter).then((page) => { if (selection.current !== scope) return; setItems((old) => [...old, ...page.data.filter((i) => !old.some((p) => p.id === i.id))]); setCursor(page.nextCursor); }).catch(report); }}>加载更多资料</button>}
        </section></>}
      </>}
      {editing && <form className="knowledge-collect" onSubmit={(e) => { e.preventDefault(); void act(async () => { await knowledgeApi.updateItem(editing, { title: editing.title, description: editing.description, tags: editing.tags, ...(editing.sourceType === "note" ? { content: editing.content ?? "" } : {}), ...(editing.sourceType === "bookmark" ? { sourceUrl: editing.sourceUrl ?? "" } : {}) }); setEditing(null); }); }}><h3>编辑资料</h3><label>标题<input required value={editing.title} maxLength={255} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></label><label>说明<textarea maxLength={5000} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></label><label>标签（逗号分隔）<input defaultValue={editing.tags.join(", ")} onBlur={(e) => setEditing({ ...editing, tags: tags(e.target.value) })} /></label>{editing.sourceType === "note" && <label>正文<textarea required maxLength={200000} rows={8} value={editing.content ?? ""} onChange={(e) => setEditing({ ...editing, content: e.target.value })} /></label>}{editing.sourceType === "bookmark" && <label>网址<input type="url" required value={editing.sourceUrl ?? ""} onChange={(e) => setEditing({ ...editing, sourceUrl: e.target.value })} /></label>}{editing.size > 0 && <label>替换原件（新版本成功前保留旧索引）<input type="file" accept={accept} disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; if (file) void act(async () => { await knowledgeApi.replaceFile(editing, file); setEditing(null); }); }} /></label>}<div className="knowledge-actions"><button disabled={busy}>保存新版本</button><button type="button" onClick={() => setEditing(null)}>放弃编辑</button></div></form>}
      {busy && <p role="status">正在处理，请稍候…</p>}
      {materialPreview && <MaterialPreview material={materialPreview} onClose={() => setMaterialPreview(null)} />}
      {preview && (selected === "materials" ? <PreviewDialog onClose={() => setPreview(null)}><SourcePreview value={preview} onClose={() => setPreview(null)} /></PreviewDialog> : <SourcePreview value={preview} onClose={() => setPreview(null)} />)}
    </main></div>
  </dialog>;
}

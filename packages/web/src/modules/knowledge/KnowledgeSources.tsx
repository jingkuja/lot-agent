import { useEffect, useRef, useState } from "react";
import { knowledgeApi, type Evidence } from "./api.js";
import { locator, SourcePreview, type Preview } from "./SourcePreview.js";
import "./knowledge.css";
export function KnowledgeSources({ sources }: { sources: Evidence[] }) {
  const [opened, setOpened] = useState<Preview>();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    if (!opened) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const validate = async () => {
      try {
        const item = await knowledgeApi.item(opened.item.id);
        if (item.activeRevisionId !== opened.revision) throw new Error("引用版本已更新或失效，请重新检索。");
        // This also validates effective dates and activation for profile facts.
        await knowledgeApi.text(item.id, opened.revision);
      } catch {
        if (!cancelled) { generation.current++; setOpened(undefined); setError("出处已更新、删除或暂不可用，请重新打开。"); }
      }
      if (!cancelled) timer = setTimeout(() => void validate(), 4000);
    };
    const focus = () => { clearTimeout(timer); void validate(); };
    timer = setTimeout(() => void validate(), 4000); window.addEventListener("focus", focus);
    return () => { cancelled = true; clearTimeout(timer); window.removeEventListener("focus", focus); };
  }, [opened]);
  const open = async (hit: Evidence) => {
    const attempt = ++generation.current; setBusy(true); setError(""); setOpened(undefined);
    try {
      const item = await knowledgeApi.item(hit.itemId);
      if (item.activeRevisionId !== hit.revisionId) throw new Error("引用版本已更新或失效，请重新检索。");
      const source = await knowledgeApi.text(hit.itemId, hit.revisionId);
      const url = item.size > 0 ? (await knowledgeApi.ticket(item.id, hit.revisionId)).url : undefined;
      if (attempt === generation.current) setOpened({ hit, item, revision: hit.revisionId, source, url });
    } catch (e) { if (attempt === generation.current) setError(e instanceof Error ? e.message : "出处不可用"); }
    finally { if (attempt === generation.current) setBusy(false); }
  };
  return <section aria-label="知识库出处"><details><summary>知识库出处（{sources.length}）</summary>
    {sources.map((hit) => <button key={hit.chunkId} disabled={busy} onClick={() => void open(hit)}>{hit.title} · {locator(hit)}</button>)}
    {error && <p role="alert">{error}</p>}{opened && <SourcePreview value={opened} onClose={() => { generation.current++; setOpened(undefined); }} />}
  </details></section>;
}

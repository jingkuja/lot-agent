import { useState } from "react";
import { knowledgeApi, type Evidence, type Source } from "./api.js";
export function KnowledgeSources({ sources }: { sources: Evidence[] }) {
  const [opened, setOpened] = useState<{ hit: Evidence; source: Source }>();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const open = async (hit: Evidence) => {
    setBusy(true); setError(""); setOpened(undefined);
    try {
      const item = await knowledgeApi.item(hit.itemId);
      if (item.activeRevisionId !== hit.revisionId) throw new Error("引用版本已更新或失效，请重新检索。");
      const source = await knowledgeApi.text(hit.itemId, hit.revisionId);
      setOpened({ hit, source });
    } catch (e) { setError(e instanceof Error ? e.message : "出处不可用"); } finally { setBusy(false); }
  };
  return <section aria-label="知识库出处"><details><summary>知识库出处（{sources.length}）</summary>
    {sources.map((hit) => <button key={hit.chunkId} disabled={busy} onClick={() => void open(hit)}>{hit.title}{hit.citation?.kind === "pdf" ? ` · 第 ${hit.citation.page} 页` : hit.citation?.kind === "text" ? ` · 第 ${hit.citation.startLine}–${hit.citation.endLine} 行` : hit.citation?.kind === "docx" ? ` · 第 ${hit.citation.paragraph} 段` : ""}</button>)}
    {error && <p role="alert">{error}</p>}{opened && <div><strong>{opened.hit.title}</strong><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{opened.source.blocks.length ? opened.source.blocks.map((b) => b.text).join("\n") : opened.source.content ?? opened.source.description}</pre><button onClick={() => setOpened(undefined)}>收起出处</button></div>}
  </details></section>;
}

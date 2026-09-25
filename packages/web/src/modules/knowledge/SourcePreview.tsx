import { useEffect, useRef } from "react";
import type { Evidence, Item, Source } from "./api.js";
export interface Preview { item: Item; revision: string; source: Source; hit?: Evidence; url?: string }
export function locator(hit: Pick<Evidence, "citation">) {
  const c = hit.citation;
  return c?.kind === "pdf" ? `第 ${c.page} 页` : c?.kind === "docx" ? `${c.heading ? `${c.heading} · ` : ""}第 ${c.paragraph}${c.endParagraph && c.endParagraph !== c.paragraph ? `–${c.endParagraph}` : ""} 段` : c?.kind === "text" ? `第 ${c.startLine}–${c.endLine} 行` : "资料说明";
}
export function matchesCitation(block: Source["blocks"][number], hit: Evidence) {
  const a = block.citation; const b = hit.citation;
  if (a?.kind === "text" && b?.kind === "text") return a.startLine <= b.endLine && a.endLine >= b.startLine;
  if (a?.kind === "docx" && b?.kind === "docx") return a.paragraph <= (b.endParagraph ?? b.paragraph) && (a.endParagraph ?? a.paragraph) >= b.paragraph;
  if (a?.kind === "pdf" && b?.kind === "pdf") return a.page === b.page;
  return block.text.includes(hit.content);
}
export function Diagnostics({ warnings = [] }: { warnings?: string[] }) {
  return <>{warnings.map((warning) => <p key={warning} role="status">{/^OCR_REQUIRED_PAGE_\d+$/.test(warning) ? `第 ${warning.slice("OCR_REQUIRED_PAGE_".length)} 页需要 OCR，本次尚未索引该页内容。` : /^OCR_EMPTY_PAGE_\d+$/.test(warning) ? `第 ${warning.slice("OCR_EMPTY_PAGE_".length)} 页未识别到文字。` : `解析提示：${warning}`}</p>)}</>;
}
export function SourcePreview({ value, onClose }: { value: Preview; onClose: () => void }) {
  const sourceRef = useRef<HTMLElement>(null);
  useEffect(() => { (sourceRef.current?.querySelector("mark") ?? sourceRef.current)?.scrollIntoView({ block: "nearest" }); }, [value]);
  const { item, source, hit, url } = value; const c = hit?.citation;
  const parts = source.blocks.length ? source.blocks : [{ text: source.content ?? source.description, citation: undefined }];
  return <section ref={sourceRef} className="knowledge-preview" aria-label="引用出处">
    <div className="knowledge-head"><h3>{item.title}{hit ? ` · ${locator(hit)}` : ""}</h3><button onClick={onClose}>收起</button></div>
    <Diagnostics warnings={source.diagnostics?.warnings} />
    <div className="knowledge-source">{parts.map((block, index) => <pre key={index}>{hit && matchesCitation(block, hit) ? <mark>{block.text}</mark> : block.text}</pre>)}</div>
    {url && <>{item.mime?.startsWith("image/") && <img src={url} alt={item.title} />}{item.mime?.startsWith("audio/") && <audio controls src={url} />}{item.mime?.startsWith("video/") && <video controls src={url} />}
      {(item.mime?.startsWith("audio/") || item.mime?.startsWith("video/")) && <p>若浏览器不支持此编码，请下载原件。预览过期后可重新打开。</p>}
      <a href={`${url}${c?.kind === "pdf" ? `#page=${c.page}` : ""}`} target="_blank" rel="noreferrer">打开 / 下载原件{c?.kind === "pdf" ? `（第 ${c.page} 页）` : ""}</a></>}
  </section>;
}

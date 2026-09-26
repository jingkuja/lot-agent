import { layoutMeta } from "../lib/layout-icons.js";

interface OutlineSlide {
  layout: string;
  title?: string;
  subtitle?: string;
  bullets?: string[];
  items?: { label: string; value?: string; desc?: string }[];
  left?: { title: string; bullets: string[] };
  right?: { title: string; bullets: string[] };
  quote?: { text: string; author?: string };
}
interface OutlineInput { title?: string; slides?: OutlineSlide[] }

interface OutlineCardProps {
  input: unknown;
  interactive: boolean;
  answer?: string;
  onReply?: (text: string) => void;
}

/** 单页摘要：把结构化字段压成一行提示文字。 */
function summary(s: OutlineSlide): string {
  if (s.bullets?.length) return s.bullets.join(" · ");
  if (s.items?.length) return s.items.map((it) => (it.value ? `${it.label} ${it.value}` : it.label)).join(" · ");
  if (s.left && s.right) return `${s.left.title} ↔ ${s.right.title}`;
  if (s.quote) return `“${s.quote.text}”${s.quote.author ? ` — ${s.quote.author}` : ""}`;
  return s.subtitle ?? "";
}

/** Tool arguments and persisted history are untrusted at the rendering boundary. */
function parseOutline(input: unknown): OutlineInput {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
  const string = (value: unknown): string => typeof value === "string" ? value : "";
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const raw = object(input);
  return {
    title: string(raw.title),
    slides: Array.isArray(raw.slides) ? raw.slides.filter(s => s && typeof s === "object").map(value => {
      const s = object(value);
      const left = object(s.left), right = object(s.right), quote = object(s.quote);
      return {
        layout: string(s.layout), title: string(s.title), subtitle: string(s.subtitle), bullets: strings(s.bullets),
        items: Array.isArray(s.items) ? s.items.map(value => {
          const item = object(value);
          return { label: string(item.label), value: string(item.value), desc: string(item.desc) };
        }) : [],
        left: s.left ? { title: string(left.title), bullets: strings(left.bullets) } : undefined,
        right: s.right ? { title: string(right.title), bullets: strings(right.bullets) } : undefined,
        quote: s.quote ? { text: string(quote.text), author: string(quote.author) } : undefined,
      };
    }) : [],
  };
}

export function OutlineCard({ input, interactive, answer, onReply }: OutlineCardProps) {
  const parsed = parseOutline(input);
  const slides = parsed.slides ?? [];
  return (
    <div className={`outline-card${interactive ? "" : " answered"}`}>
      <div className="outline-head">
        <span className="outline-title">{parsed.title || "演示大纲"}</span>
        <span className="outline-count">共 {slides.length} 页</span>
      </div>
      <ol className="outline-list">
        {slides.map((s, i) => {
          const m = layoutMeta(s.layout);
          const sum = summary(s);
          return (
            <li key={i} className="outline-row">
              <span className="outline-index">{i + 1}</span>
              <span className="outline-layout" title={m.label}>{m.icon}</span>
              <span className="outline-body">
                <span className="outline-slide-title">{s.title || m.label}</span>
                {sum && <span className="outline-slide-sum">{sum}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {interactive ? (
        <div className="outline-actions">
          <button type="button" className="outline-confirm" onClick={() => onReply?.("确认，按此大纲生成")}>
            ✓ 确认生成
          </button>
          <span className="outline-hint">或直接在下方输入修改意见（如「第 3 页改成对比」）</span>
        </div>
      ) : (
        answer && <div className="outline-answered-note">已回复：{answer}</div>
      )}
    </div>
  );
}

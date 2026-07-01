import { useState, useRef, useEffect } from "react";
import { filterModels, type CatalogModel } from "../lib/model-filter.js";

/** Bottom-right model selector with a letter quick-filter. Popover styling reuses
 * the media-picker tokens; all colors via var(--*). */
export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: CatalogModel[];
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = value ?? models[0]?.id ?? "选择模型";
  const filtered = filterModels(models, query);

  return (
    <div className="media-picker model-picker" ref={wrapRef}>
      <button
        type="button"
        className="media-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        title="选择模型"
      >
        <span className="media-trigger-label">{current}</span>
        <svg className="media-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="media-popup model-popup">
          <input
            className="model-search"
            autoFocus
            placeholder="输入字母快速筛选…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="model-list">
            {filtered.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`model-row ${m.id === value ? "active" : ""}`}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
              >
                <span className="model-row-name">{m.label ?? m.id}</span>
                {m.description && <span className="model-row-desc">{m.description}</span>}
              </button>
            ))}
            {filtered.length === 0 && <div className="model-empty">无匹配模型</div>}
          </div>
        </div>
      )}
    </div>
  );
}

import type { PptLayout, PptSlide } from "./renderer.js";

export const PPT_LAYOUTS: readonly PptLayout[] = [
  "cover", "agenda", "section", "content", "keypoints",
  "stats", "compare", "timeline", "quote", "closing",
];
const LAYOUT_SET = new Set<string>(PPT_LAYOUTS);
const MAX_SLIDES = 40;

function nonEmpty(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}
function bulletsOk(b: unknown, min: number, max: number): boolean {
  return Array.isArray(b) && b.length >= min && b.length <= max && b.every((x) => typeof x === "string");
}

/** 逐版式校验；返回首个错误消息（中文，便于 LLM 自修复），全部通过返回 null。 */
export function validateSlides(slides: unknown): string | null {
  if (!Array.isArray(slides) || slides.length === 0) return "slides 需为非空数组（至少一页）。";
  if (slides.length > MAX_SLIDES) return `slides 过多（最多 ${MAX_SLIDES} 页）。`;
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i] as PptSlide;
    const at = `第 ${i + 1} 页`;
    if (!s || typeof s !== "object") return `${at}不是合法对象。`;
    if (!LAYOUT_SET.has(s.layout)) return `${at}的 layout 非法（应为 ${PPT_LAYOUTS.join("/")}）。`;
    if (s.layout !== "quote" && !nonEmpty(s.title)) return `${at}(${s.layout}) 需要非空 title。`;
    switch (s.layout) {
      case "content":
        if (!bulletsOk(s.bullets, 1, 8)) return `${at}(content) 需要 1-8 条 bullets。`;
        break;
      case "agenda":
        if (s.items !== undefined && !(Array.isArray(s.items) && s.items.length >= 2 && s.items.length <= 10))
          return `${at}(agenda) 的 items 给出时需 2-10 条（也可缺省自动生成）。`;
        break;
      case "keypoints":
        if (!Array.isArray(s.items) || s.items.length < 2 || s.items.length > 6)
          return `${at}(keypoints) 需要 2-6 个 items。`;
        if (!s.items.every((it) => nonEmpty(it?.label))) return `${at}(keypoints) 每个 item 需要 label。`;
        break;
      case "stats":
        if (!Array.isArray(s.items) || s.items.length < 2 || s.items.length > 4)
          return `${at}(stats) 需要 2-4 个 items。`;
        if (!s.items.every((it) => nonEmpty(it?.value) && nonEmpty(it?.label)))
          return `${at}(stats) 每个 item 需要 value 与 label。`;
        break;
      case "compare":
        if (!s.left || !s.right || !nonEmpty(s.left.title) || !nonEmpty(s.right.title))
          return `${at}(compare) 需要 left 与 right，且各有 title。`;
        if (!bulletsOk(s.left.bullets, 1, 5) || !bulletsOk(s.right.bullets, 1, 5))
          return `${at}(compare) 的 left/right 各需 1-5 条 bullets。`;
        break;
      case "timeline":
        if (!Array.isArray(s.items) || s.items.length < 3 || s.items.length > 6)
          return `${at}(timeline) 需要 3-6 个 items。`;
        if (!s.items.every((it) => nonEmpty(it?.label))) return `${at}(timeline) 每个 item 需要 label。`;
        break;
      case "quote":
        if (!s.quote || !nonEmpty(s.quote.text)) return `${at}(quote) 需要非空 quote.text。`;
        break;
      // cover / section / closing：title 已校验
    }
  }
  return null;
}

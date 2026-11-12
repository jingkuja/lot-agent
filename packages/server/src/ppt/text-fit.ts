import { textUnits } from "@lot-agent/core/presentation";

/** Estimated wrapped line count at a font size (pt) in a box of `w` inches. Layouts and fitText share it. */
export function linesFor(text: string, size: number, w: number): number {
  const width = Math.max(0.1, w - 0.22);
  return text.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(textUnits(line) * size / (width * 72))), 0);
}

/**
 * Estimated text height in inches, used to size boxes around their content. Single spacing in
 * Office CJK fonts is about 1.32 em, and `multiple` is the box's lineSpacingMultiple.
 */
export function textHeight(text: string, size: number, w: number, multiple = 1): number {
  return linesFor(text, size, w) * size * 1.32 * multiple / 72 + 0.06;
}

/** Fit a group of text rows at one font size, keeping the gaps within the layout's range. */
export function fitRows(heights: (size: number) => number[], available: number, sizes: number[], minGap: number, maxGap = minGap) {
  for (const size of sizes) {
    const rows = heights(size);
    const used = rows.reduce((sum, h) => sum + h, 0);
    const gaps = Math.max(0, rows.length - 1);
    if (used + minGap * gaps <= available || size === sizes.at(-1)) {
      const gap = gaps ? Math.max(minGap, Math.min(maxGap, (available - used) / gaps)) : 0;
      return { size, rows, gap, total: used + gap * gaps };
    }
  }
  throw new Error("No font sizes available");
}

/** Conservative pre-export sizing, plus Office's shrink fallback. No text is truncated. */
export function fitText(text: string | { text?: string; options?: { breakLine?: boolean } }[], options: Record<string, any>): Record<string, any> {
  if (typeof options.w !== "number" || typeof options.h !== "number") return options;
  const value = typeof text === "string" ? text : text.map(run => (run.text ?? "") + (run.options?.breakLine ? "\n" : "")).join("").trimEnd();
  const preferred = options.fontSize ?? 18;
  const floor = Math.min(preferred, 12);
  const height = Math.max(0.1, options.h - 0.06);
  let size = preferred;
  for (; size > floor; size--) {
    const lines = linesFor(value, size, options.w);
    const paragraphGap = Array.isArray(text) ? Math.max(0, text.length - 1) * 8 : 0;
    if ((lines * size * (options.lineSpacingMultiple ?? 1.18) + paragraphGap) / 72 <= height) break;
  }
  return { margin: 0, isTextBox: true, ...options, fontSize: size, fit: "shrink", breakLine: false };
}

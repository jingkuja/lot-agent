import { textUnits } from "@lot-agent/core/presentation";

/** Conservative pre-export sizing, plus Office's shrink fallback. No text is truncated. */
export function fitText(text: string | { text: string; options?: { breakLine?: boolean } }[], options: Record<string, any>): Record<string, any> {
  if (typeof options.w !== "number" || typeof options.h !== "number") return options;
  const value = typeof text === "string" ? text : text.map(run => run.text + (run.options?.breakLine ? "\n" : "")).join("").trimEnd();
  const preferred = options.fontSize ?? 18;
  const floor = Math.min(preferred, 12);
  const width = Math.max(0.1, options.w - 0.22);
  const height = Math.max(0.1, options.h - 0.06);
  let size = preferred;
  for (; size > floor; size--) {
    const lines = value.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(textUnits(line) * size / (width * 72))), 0);
    const paragraphGap = Array.isArray(text) ? Math.max(0, text.length - 1) * 8 : 0;
    if ((lines * size * (options.lineSpacingMultiple ?? 1.18) + paragraphGap) / 72 <= height) break;
  }
  return { margin: 0, ...options, fontSize: size, fit: "shrink", breakLine: false };
}

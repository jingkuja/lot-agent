import type { PptTheme } from "../theme-extractor.js";
import type { PptLayout } from "../renderer.js";

export type PptxSlide = any;

export interface BuildCtx {
  c: PptTheme["colors"];
  f: PptTheme["fonts"];
  W: number;
  H: number;
  theme: PptTheme;
  index: number;   // 0-based
  total: number;
  presTitle: string;
  /** 供 agenda 版式：缺省 items 时用后续 section 标题填充。 */
  agendaItems?: string[];
  layout: PptLayout;
}

/** 把 hex 调暗 amount（0-1）。 */
export function darken(hex: string, amount: number): string {
  const p = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount));
  return [p(0), p(2), p(4)]
    .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

const ACCENTS: (keyof PptTheme["colors"])[] = [
  "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
];
/** 按序轮换取 accent 色（用于卡片/节点/序号多彩化）。 */
export function accentAt(c: PptTheme["colors"], i: number): string {
  return c[ACCENTS[((i % 6) + 6) % 6]];
}

/** 依主题装饰语言画角落装饰；minimal 不画。 */
export function drawDecor(slide: PptxSlide, ctx: BuildCtx): void {
  const { c, W, H, theme } = ctx;
  if (theme.decor === "minimal") return;
  if (theme.decor === "circles") {
    slide.addShape("ellipse", { x: W * 0.82, y: -H * 0.12, w: H * 0.42, h: H * 0.42, fill: { color: c.accent1, transparency: 92 }, line: { type: "none" } });
    return;
  }
  if (theme.decor === "slant") {
    slide.addShape("rect", { x: W * 0.88, y: 0, w: W * 0.12, h: H, fill: { color: c.accent1, transparency: 90 }, line: { type: "none" }, rotate: 12 });
    return;
  }
  if (theme.decor === "grid") {
    for (let i = 1; i <= 3; i++) {
      slide.addShape("line", { x: 0, y: (H / 4) * i, w: W, h: 0, line: { color: c.dk2, width: 0.5, transparency: 92 } });
    }
  }
}

export function bgRoleFor(layout: PptLayout): "cover" | "section" | "body" {
  if (layout === "cover" || layout === "closing") return "cover";
  if (layout === "section") return "section";
  return "body";
}

/** 若主题为该版式配了背景图：贴整页图 + 遮罩，返回 true（否则不动 slide.background）。 */
export function applyBackground(slide: PptxSlide, ctx: BuildCtx): boolean {
  const bg = ctx.theme.backgrounds?.[bgRoleFor(ctx.layout)];
  if (!bg) return false;
  const b64 = bg.image.toString("base64");
  const mime = bg.ext === "jpeg" ? "image/jpeg" : "image/png";
  slide.background = { data: `data:${mime};base64,${b64}` };
  if (bg.overlay !== "none") {
    const dark = bg.overlay === "dark";
    slide.addShape("rect", { x: 0, y: 0, w: ctx.W, h: ctx.H, fill: { color: dark ? "000000" : "FFFFFF", transparency: dark ? 45 : 25 }, line: { type: "none" } });
  }
  return true;
}

/** 文字色：贴了深遮罩（或无 overlay 的背景）→ 白字；浅遮罩/无背景 → 主题深色。 */
export function inkColors(ctx: BuildCtx): { title: string; body: string; onBg: boolean } {
  const bg = ctx.theme.backgrounds?.[bgRoleFor(ctx.layout)];
  if (bg && bg.overlay !== "light") return { title: "FFFFFF", body: "F0F0F5", onBg: true };
  return { title: ctx.c.dk1, body: ctx.c.dk2, onBg: !!bg };
}

/** 内容类版式底部：细分隔线 + 演示标题 + 页码。 */
export function drawFooter(slide: PptxSlide, ctx: BuildCtx): void {
  const { c, f, W, H, index, total, presTitle } = ctx;
  slide.addShape("line", { x: W * 0.06, y: H * 0.93, w: W * 0.88, h: 0, line: { color: c.dk2, width: 0.75, transparency: 80 } });
  slide.addText(presTitle, { x: W * 0.06, y: H * 0.935, w: W * 0.6, h: 0.3, fontFace: f.minor, fontSize: 9, color: c.dk2, valign: "middle" });
  slide.addText(`${index + 1} / ${total}`, { x: W * 0.74, y: H * 0.935, w: W * 0.2, h: 0.3, fontFace: f.minor, fontSize: 9, color: c.dk2, align: "right", valign: "middle" });
}

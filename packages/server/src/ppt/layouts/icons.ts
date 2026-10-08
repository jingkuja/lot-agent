import type { PptItem } from "@lot-agent/core/presentation";
import type { PptxSlide } from "./ctx.js";

/** Small semantic, editable Office symbols; no remote assets or image-model charges. */
export function drawIcon(slide: PptxSlide, icon: NonNullable<PptItem["icon"]>, x: number, y: number, size: number, color: string): void {
  const outline = { line: { color, width: 1.6 }, fill: { color, transparency: 100 } };
  const shape = (type: string, dx: number, dy: number, w: number, h: number, extra: object = {}) => slide.addShape(type, { x: x + dx * size, y: y + dy * size, w: w * size, h: h * size, ...outline, ...extra });
  switch (icon) {
    case "target":
      shape("ellipse", 0, 0, 1, 1); shape("ellipse", .28, .28, .44, .44); break;
    case "trend":
      shape("upArrow", .2, 0, .6, 1); break;
    case "check":
      shape("line", .05, .45, .3, .3); shape("line", .35, .1, .6, .65, { flipV: true }); break;
    case "people":
      shape("ellipse", .08, .04, .3, .3); shape("ellipse", .62, .04, .3, .3);
      shape("roundRect", .02, .5, .42, .45); shape("roundRect", .56, .5, .42, .45); break;
    case "clock":
      shape("ellipse", 0, 0, 1, 1); shape("line", .5, .2, 0, .32); shape("line", .5, .52, .25, 0); break;
    case "shield":
      shape("pentagon", .05, 0, .9, 1, { rotate: 180 }); break;
  }
}

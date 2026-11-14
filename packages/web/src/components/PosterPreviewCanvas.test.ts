import { describe, expect, it } from "vitest";
import { normalizeAngle, snapOffsetWithGuides, snapRotateAngle } from "./PosterPreviewCanvas.js";
import type { PosterPreviewScene, PosterStyle } from "@lot-agent/core/poster";

describe("PosterPreviewCanvas math", () => {
  it("normalizes and magnetically snaps rotation angles", () => {
    expect(normalizeAngle(185)).toBe(-175);
    expect(normalizeAngle(-185)).toBe(175);
    expect(snapRotateAngle(2)).toBe(0);
    expect(snapRotateAngle(-44)).toBe(-45);
    expect(snapRotateAngle(14)).toBe(14);
    expect(snapRotateAngle(14, true)).toBe(15);
    expect(snapRotateAngle(88, true)).toBe(90);
  });

  it("snaps dragged layer to canvas center and sibling edges with guide lines", () => {
    const scene: PosterPreviewScene = {
      width: 1000,
      height: 1000,
      background: "data:image/jpeg;base64,",
      layers: [
        { kind: "text", part: "title", left: 300, top: 100, width: 400, height: 100, src: "" },
        { kind: "text", part: "subtitle", left: 350, top: 300, width: 300, height: 60, src: "" },
      ],
    };
    const style: PosterStyle = { font: "sans", titleWeight: "bold", scrim: "auto" };

    // Dragged subtitle slightly off center (raw dx = 0.6%) snaps back to canvas center (500px, dx = 0).
    const centered = snapOffsetWithGuides(scene, style, "subtitle", { dx: 0.6, dy: 20 }, 10);
    expect(centered.offset.dx).toBe(0);
    expect(centered.guides.x).toBe(500);
    expect(centered.guides.y).toBe(500);

    // Dragging subtitle left edge near title left edge (300px => dx = -5%) snaps to title left.
    const edgeAligned = snapOffsetWithGuides(scene, style, "subtitle", { dx: -4.4, dy: 12 }, 10);
    expect(edgeAligned.offset.dx).toBe(-5);
    expect(edgeAligned.guides.x).toBe(300);

    // Holding Alt disables snapping.
    const free = snapOffsetWithGuides(scene, style, "subtitle", { dx: 0.6, dy: 12 }, 10, true);
    expect(free.offset).toEqual({ dx: 0.6, dy: 12 });
    expect(free.guides).toEqual({});
  });
});

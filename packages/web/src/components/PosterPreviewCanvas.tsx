import { useEffect, useRef, useState, type PointerEvent } from "react";
import { POSTER_FONT_SCALE, POSTER_NUDGE_LIMIT, type PosterPart, type PosterPreviewScene, type PosterStyle } from "@lot-agent/core/poster";
import { useI18n } from "../i18n/index.js";

export const POSTER_PART_LABELS: Record<PosterPart, string> = {
  title: "标题", subtitle: "副标题", points: "卖点", price: "价格", date: "时间", address: "地址",
};

type Offset = { dx: number; dy: number };
interface Drag {
  pointerId: number;
  part: PosterPart;
  x: number;
  y: number;
  width: number;
  height: number;
  start: Offset;
}

const ARROW_STEPS: Record<string, Offset> = {
  ArrowUp: { dx: 0, dy: -1 }, ArrowDown: { dx: 0, dy: 1 }, ArrowLeft: { dx: -1, dy: 0 }, ArrowRight: { dx: 1, dy: 0 },
};

function clamp(value: number): number {
  return Math.max(-POSTER_NUDGE_LIMIT, Math.min(POSTER_NUDGE_LIMIT, value));
}

function clampFontScale(value: number): number {
  return Math.max(POSTER_FONT_SCALE.min, Math.min(POSTER_FONT_SCALE.max, value));
}

interface ResizeDrag {
  pointerId: number;
  part: PosterPart;
  cx: number;
  cy: number;
  startDist: number;
  startScale: number;
}

interface RotateDrag {
  pointerId: number;
  part: PosterPart;
  cx: number;
  cy: number;
  startPointerAngle: number;
  startRotate: number;
}

export interface SnapGuides {
  x?: number;
  y?: number;
}

const RESIZE_CORNERS = ["nw", "ne", "sw", "se"] as const;
const SNAP_ANGLES = [-180, -135, -90, -45, 0, 45, 90, 135, 180];

export function normalizeAngle(deg: number): number {
  const wrapped = ((Math.round(deg) + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 && deg > 0 ? 180 : wrapped;
}

export function snapRotateAngle(deg: number, coarse = false): number {
  const norm = normalizeAngle(deg);
  if (coarse) return normalizeAngle(Math.round(norm / 15) * 15);
  return SNAP_ANGLES.find((anchor) => Math.abs(norm - anchor) <= 3) ?? norm;
}

function snapAxis(
  baseStart: number, span: number, rawDeltaPct: number, canvasSpan: number, targets: number[], thresholdPx: number,
): { deltaPct: number; guidePx?: number } {
  const shiftPx = (rawDeltaPct * canvasSpan) / 100;
  let bestDist = thresholdPx;
  let bestShiftPx = shiftPx;
  let guidePx: number | undefined;
  for (const anchor of [0, span / 2, span]) {
    const currentPos = baseStart + shiftPx + anchor;
    for (const target of targets) {
      const dist = Math.abs(currentPos - target);
      if (dist <= bestDist) {
        bestDist = dist;
        bestShiftPx = target - baseStart - anchor;
        guidePx = target;
      }
    }
  }
  if (guidePx === undefined) return { deltaPct: rawDeltaPct };
  return { deltaPct: clamp(Math.round((bestShiftPx * 100) / canvasSpan)), guidePx };
}

/** Snap an active layer's drag offset against canvas center, safe margins, and sibling text layers. */
export function snapOffsetWithGuides(
  scene: PosterPreviewScene, style: PosterStyle, activePart: PosterPart, rawOffset: Offset, thresholdPx: number, disabled = false,
): { offset: Offset; guides: SnapGuides } {
  if (disabled) return { offset: rawOffset, guides: {} };
  const active = scene.layers.find((layer) => layer.kind === "text" && layer.part === activePart);
  if (!active || active.kind !== "text") return { offset: rawOffset, guides: {} };
  const { width, height } = scene;
  const xTargets = [width * 0.06, width * 0.5, width * 0.94];
  const yTargets = [height * 0.06, height * 0.5, height * 0.94];
  for (const layer of scene.layers) {
    if (layer.kind !== "text" || layer.part === activePart) continue;
    const own = style.parts?.[layer.part];
    const ox = Math.round(((own?.dx ?? 0) * width) / 100);
    const oy = Math.round(((own?.dy ?? 0) * height) / 100);
    xTargets.push(layer.left + ox, layer.left + ox + layer.width / 2, layer.left + ox + layer.width);
    yTargets.push(layer.top + oy, layer.top + oy + layer.height / 2, layer.top + oy + layer.height);
  }
  const snappedX = snapAxis(active.left, active.width, rawOffset.dx, width, xTargets, thresholdPx);
  const snappedY = snapAxis(active.top, active.height, rawOffset.dy, height, yTargets, thresholdPx);
  return {
    offset: { dx: snappedX.deltaPct, dy: snappedY.deltaPct },
    guides: {
      ...(snappedX.guidePx !== undefined ? { x: snappedX.guidePx } : {}),
      ...(snappedY.guidePx !== undefined ? { y: snappedY.guidePx } : {}),
    },
  };
}

function scaleAt(resize: ResizeDrag, event: PointerEvent): number {
  const dist = Math.max(12, Math.hypot(event.clientX - resize.cx, event.clientY - resize.cy));
  const raw = resize.startScale * (dist / resize.startDist);
  return clampFontScale(Math.round(raw / 5) * 5);
}

function rotateAt(rot: RotateDrag, event: PointerEvent): number {
  const curAngle = (Math.atan2(event.clientY - rot.cy, event.clientX - rot.cx) * 180) / Math.PI;
  const delta = normalizeAngle(curAngle - rot.startPointerAngle);
  return snapRotateAngle(rot.startRotate + delta, event.shiftKey);
}

function offsetAt(drag: Drag, event: PointerEvent): Offset {
  return {
    dx: clamp(drag.start.dx + (event.clientX - drag.x) * 100 / drag.width),
    dy: clamp(drag.start.dy + (event.clientY - drag.y) * 100 / drag.height),
  };
}

interface Props {
  scene: PosterPreviewScene;
  style: PosterStyle;
  interactive: boolean;
  onMove: (part: PosterPart, offset: Offset) => void;
  onResize?: (part: PosterPart, fontScale: number) => void;
  onRotate?: (part: PosterPart, rotate: number) => void;
}

export function PosterPreviewCanvas({ scene, style, interactive, onMove, onResize, onRotate }: Props) {
  const { t } = useI18n();
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const resize = useRef<ResizeDrag | null>(null);
  const rotateDrag = useRef<RotateDrag | null>(null);
  const [motion, setMotion] = useState<{ part: PosterPart; offset: Offset }>();
  const [guides, setGuides] = useState<SnapGuides>();
  const [scaleMotion, setScaleMotion] = useState<{ part: PosterPart; fontScale: number }>();
  const [rotateMotion, setRotateMotion] = useState<{ part: PosterPart; rotate: number }>();
  const [selected, setSelected] = useState<PosterPart | null>(null);
  const { width, height } = scene;

  useEffect(() => {
    drag.current = null;
    resize.current = null;
    rotateDrag.current = null;
    setMotion(undefined);
    setGuides(undefined);
    setScaleMotion(undefined);
    setRotateMotion(undefined);
  }, [scene, interactive]);

  const snappedMotion = (active: Drag, event: PointerEvent) => {
    const threshold = Math.max(4, (width / active.width) * 6);
    return snapOffsetWithGuides(scene, style, active.part, offsetAt(active, event), threshold, event.altKey);
  };

  const start = (event: PointerEvent<HTMLButtonElement>, part: PosterPart, offset: Offset) => {
    setSelected(part);
    if (!interactive || event.button !== 0 || drag.current || resize.current || rotateDrag.current) return;
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      part, pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, start: offset,
    };
    setMotion({ part, offset });
    setGuides(undefined);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    const snapped = snappedMotion(active, event);
    setMotion({ part: active.part, offset: snapped.offset });
    setGuides(snapped.guides);
  };
  const end = (event: PointerEvent<HTMLButtonElement>, commit: boolean) => {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    drag.current = null;
    setMotion(undefined);
    setGuides(undefined);
    if (!commit || !interactive) return;
    const next = snappedMotion(active, event).offset;
    const dx = Math.round(next.dx);
    const dy = Math.round(next.dy);
    if (dx !== active.start.dx || dy !== active.start.dy) onMove(active.part, { dx, dy });
  };

  const startResize = (event: PointerEvent<HTMLSpanElement>, part: PosterPart, startScale: number) => {
    event.stopPropagation();
    setSelected(part);
    if (!interactive || !onResize || event.button !== 0 || resize.current || drag.current || rotateDrag.current) return;
    const parentRect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!parentRect?.width || !parentRect.height) return;
    const cx = parentRect.left + parentRect.width / 2;
    const cy = parentRect.top + parentRect.height / 2;
    const startDist = Math.max(12, Math.hypot(event.clientX - cx, event.clientY - cy));
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = { pointerId: event.pointerId, part, cx, cy, startDist, startScale };
    setScaleMotion({ part, fontScale: startScale });
  };
  const moveResize = (event: PointerEvent<HTMLSpanElement>) => {
    const active = resize.current;
    if (active?.pointerId === event.pointerId) {
      event.stopPropagation();
      setScaleMotion({ part: active.part, fontScale: scaleAt(active, event) });
    }
  };
  const endResize = (event: PointerEvent<HTMLSpanElement>, commit: boolean) => {
    const active = resize.current;
    if (active?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    resize.current = null;
    setScaleMotion(undefined);
    if (!commit || !interactive || !onResize) return;
    const nextScale = scaleAt(active, event);
    if (nextScale !== active.startScale) onResize(active.part, nextScale);
  };

  const startRotate = (event: PointerEvent<HTMLSpanElement>, part: PosterPart, startRotateAngle: number) => {
    event.stopPropagation();
    setSelected(part);
    if (!interactive || !onRotate || event.button !== 0 || rotateDrag.current || drag.current || resize.current) return;
    const parentRect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!parentRect?.width || !parentRect.height) return;
    const cx = parentRect.left + parentRect.width / 2;
    const cy = parentRect.top + parentRect.height / 2;
    const startPointerAngle = (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI;
    event.currentTarget.setPointerCapture(event.pointerId);
    rotateDrag.current = { pointerId: event.pointerId, part, cx, cy, startPointerAngle, startRotate: startRotateAngle };
    setRotateMotion({ part, rotate: startRotateAngle });
  };
  const moveRotate = (event: PointerEvent<HTMLSpanElement>) => {
    const active = rotateDrag.current;
    if (active?.pointerId === event.pointerId) {
      event.stopPropagation();
      setRotateMotion({ part: active.part, rotate: rotateAt(active, event) });
    }
  };
  const endRotate = (event: PointerEvent<HTMLSpanElement>, commit: boolean) => {
    const active = rotateDrag.current;
    if (active?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    rotateDrag.current = null;
    setRotateMotion(undefined);
    if (!commit || !interactive || !onRotate) return;
    const nextAngle = rotateAt(active, event);
    if (nextAngle !== active.startRotate) onRotate(active.part, nextAngle);
  };

  return <div ref={canvas} className="poster-preview-canvas" onPointerDown={(event) => {
    if (event.target === event.currentTarget) setSelected(null);
  }} style={{
    aspectRatio: width / height, width: `min(100%, ${width}px, calc(var(--poster-preview-max-height) * ${width / height}))`,
  }}>
    <img className="poster-preview-photo" src={scene.background} alt={t("预览效果")} draggable={false} />
    {scene.layers.map((layer, index) => {
      const part = layer.kind === "scrim" ? undefined : layer.part;
      const own = part ? style.parts?.[part] : undefined;
      const offset = { dx: own?.dx ?? 0, dy: own?.dy ?? 0 };
      const fontScale = own?.fontScale ?? POSTER_FONT_SCALE.default;
      const baseRotate = own?.rotate ?? 0;
      const live = motion && motion.part === part ? motion.offset : undefined;
      const liveScale = scaleMotion && scaleMotion.part === part ? scaleMotion.fontScale : undefined;
      const liveRotate = rotateMotion && rotateMotion.part === part ? rotateMotion.rotate : undefined;
      const angle = liveRotate ?? baseRotate;
      const x = live ? live.dx * width / 100 : Math.round(offset.dx * width / 100);
      const y = live ? live.dy * height / 100 : Math.round(offset.dy * height / 100);
      const transforms: string[] = [];
      if (angle) transforms.push(`rotate(${angle}deg)`);
      if (liveScale !== undefined) transforms.push(`scale(${liveScale / fontScale})`);
      const position = {
        left: `${(layer.left + x) * 100 / width}%`, top: `${(layer.top + y) * 100 / height}%`,
        width: `${layer.width * 100 / width}%`, height: `${layer.height * 100 / height}%`,
        transform: transforms.length ? transforms.join(" ") : undefined,
      };
      if (layer.kind !== "text") return <img key={index} className="poster-preview-layer" src={layer.src} alt="" style={position} draggable={false} />;
      const badgeText = liveScale !== undefined ? `${liveScale}%` : liveRotate !== undefined ? `${liveRotate}°` : undefined;
      return <button type="button" key={layer.part}
        className={`poster-preview-layer poster-preview-part${selected === layer.part ? " is-selected" : ""}`}
        style={position} disabled={!interactive}
        aria-label={t("{0}位置", [t(POSTER_PART_LABELS[layer.part])])} aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
        data-dragging={!!live || liveScale !== undefined || liveRotate !== undefined}
        onPointerDown={(event) => start(event, layer.part, offset)} onPointerMove={move}
        onPointerUp={(event) => end(event, true)} onPointerCancel={(event) => end(event, false)} onLostPointerCapture={(event) => end(event, false)}
        onKeyDown={(event) => {
          const step = ARROW_STEPS[event.key];
          if (!step || drag.current || resize.current || rotateDrag.current) return;
          event.preventDefault();
          onMove(layer.part, { dx: clamp(offset.dx + step.dx), dy: clamp(offset.dy + step.dy) });
        }}>
        <img src={layer.src} alt="" draggable={false} />
        {interactive && onResize && RESIZE_CORNERS.map((corner) => (
          <span key={corner} className={`poster-preview-handle poster-preview-handle--${corner}`} aria-hidden
            onPointerDown={(event) => startResize(event, layer.part, fontScale)}
            onPointerMove={moveResize}
            onPointerUp={(event) => endResize(event, true)}
            onPointerCancel={(event) => endResize(event, false)}
            onLostPointerCapture={(event) => endResize(event, false)} />
        ))}
        {interactive && onRotate && (
          <span className="poster-preview-rotate-handle" aria-hidden
            onPointerDown={(event) => startRotate(event, layer.part, baseRotate)}
            onPointerMove={moveRotate}
            onPointerUp={(event) => endRotate(event, true)}
            onPointerCancel={(event) => endRotate(event, false)}
            onLostPointerCapture={(event) => endRotate(event, false)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </span>
        )}
        {badgeText && <span className="poster-preview-scale-tag">{badgeText}</span>}
      </button>;
    })}
    {guides?.x !== undefined && (
      <div className="poster-preview-guide poster-preview-guide--x" style={{ left: `${(guides.x * 100) / width}%` }} aria-hidden />
    )}
    {guides?.y !== undefined && (
      <div className="poster-preview-guide poster-preview-guide--y" style={{ top: `${(guides.y * 100) / height}%` }} aria-hidden />
    )}
  </div>;
}

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

const RESIZE_CORNERS = ["nw", "ne", "sw", "se"] as const;

function scaleAt(resize: ResizeDrag, event: PointerEvent): number {
  const dist = Math.max(12, Math.hypot(event.clientX - resize.cx, event.clientY - resize.cy));
  const raw = resize.startScale * (dist / resize.startDist);
  return clampFontScale(Math.round(raw / 5) * 5);
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
}

export function PosterPreviewCanvas({ scene, style, interactive, onMove, onResize }: Props) {
  const { t } = useI18n();
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const resize = useRef<ResizeDrag | null>(null);
  const [motion, setMotion] = useState<{ part: PosterPart; offset: Offset }>();
  const [scaleMotion, setScaleMotion] = useState<{ part: PosterPart; fontScale: number }>();
  const [selected, setSelected] = useState<PosterPart | null>(null);
  const { width, height } = scene;

  useEffect(() => {
    drag.current = null;
    resize.current = null;
    setMotion(undefined);
    setScaleMotion(undefined);
  }, [scene, interactive]);

  const start = (event: PointerEvent<HTMLButtonElement>, part: PosterPart, offset: Offset) => {
    setSelected(part);
    if (!interactive || event.button !== 0 || drag.current || resize.current) return;
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      part, pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, start: offset,
    };
    setMotion({ part, offset });
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (active?.pointerId === event.pointerId) setMotion({ part: active.part, offset: offsetAt(active, event) });
  };
  const end = (event: PointerEvent<HTMLButtonElement>, commit: boolean) => {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    drag.current = null;
    setMotion(undefined);
    if (!commit || !interactive) return;
    const next = offsetAt(active, event);
    const dx = Math.round(next.dx);
    const dy = Math.round(next.dy);
    if (dx !== active.start.dx || dy !== active.start.dy) onMove(active.part, { dx, dy });
  };

  const startResize = (event: PointerEvent<HTMLSpanElement>, part: PosterPart, startScale: number) => {
    event.stopPropagation();
    setSelected(part);
    if (!interactive || !onResize || event.button !== 0 || resize.current || drag.current) return;
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
      const live = motion && motion.part === part ? motion.offset : undefined;
      const liveScale = scaleMotion && scaleMotion.part === part ? scaleMotion.fontScale : undefined;
      const x = live ? live.dx * width / 100 : Math.round(offset.dx * width / 100);
      const y = live ? live.dy * height / 100 : Math.round(offset.dy * height / 100);
      const position = {
        left: `${(layer.left + x) * 100 / width}%`, top: `${(layer.top + y) * 100 / height}%`,
        width: `${layer.width * 100 / width}%`, height: `${layer.height * 100 / height}%`,
        transform: liveScale !== undefined ? `scale(${liveScale / fontScale})` : undefined,
      };
      if (layer.kind !== "text") return <img key={index} className="poster-preview-layer" src={layer.src} alt="" style={position} draggable={false} />;
      return <button type="button" key={layer.part}
        className={`poster-preview-layer poster-preview-part${selected === layer.part ? " is-selected" : ""}`}
        style={position} disabled={!interactive}
        aria-label={t("{0}位置", [t(POSTER_PART_LABELS[layer.part])])} aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
        data-dragging={!!live || liveScale !== undefined} onPointerDown={(event) => start(event, layer.part, offset)} onPointerMove={move}
        onPointerUp={(event) => end(event, true)} onPointerCancel={(event) => end(event, false)} onLostPointerCapture={(event) => end(event, false)}
        onKeyDown={(event) => {
          const step = ARROW_STEPS[event.key];
          if (!step || drag.current || resize.current) return;
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
        {liveScale !== undefined && <span className="poster-preview-scale-tag">{liveScale}%</span>}
      </button>;
    })}
  </div>;
}

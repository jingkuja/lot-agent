import { useEffect, useRef, useState, type PointerEvent } from "react";
import { POSTER_NUDGE_LIMIT, type PosterPart, type PosterPreviewScene, type PosterStyle } from "@lot-agent/core/poster";
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
}

export function PosterPreviewCanvas({ scene, style, interactive, onMove }: Props) {
  const { t } = useI18n();
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [motion, setMotion] = useState<{ part: PosterPart; offset: Offset }>();
  const { width, height } = scene;

  useEffect(() => {
    if (!drag.current) return;
    drag.current = null;
    setMotion(undefined);
  }, [scene, interactive]);

  const start = (event: PointerEvent<HTMLButtonElement>, part: PosterPart, offset: Offset) => {
    if (!interactive || event.button !== 0 || drag.current) return;
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

  return <div ref={canvas} className="poster-preview-canvas" style={{
    aspectRatio: width / height, width: `min(100%, ${width}px, calc(var(--poster-preview-max-height) * ${width / height}))`,
  }}>
    <img className="poster-preview-photo" src={scene.background} alt={t("预览效果")} draggable={false} />
    {scene.layers.map((layer, index) => {
      const part = layer.kind === "scrim" ? undefined : layer.part;
      const own = part ? style.parts?.[part] : undefined;
      const offset = { dx: own?.dx ?? 0, dy: own?.dy ?? 0 };
      const live = motion && motion.part === part ? motion.offset : undefined;
      const x = live ? live.dx * width / 100 : Math.round(offset.dx * width / 100);
      const y = live ? live.dy * height / 100 : Math.round(offset.dy * height / 100);
      const position = {
        left: `${(layer.left + x) * 100 / width}%`, top: `${(layer.top + y) * 100 / height}%`,
        width: `${layer.width * 100 / width}%`, height: `${layer.height * 100 / height}%`,
      };
      if (layer.kind !== "text") return <img key={index} className="poster-preview-layer" src={layer.src} alt="" style={position} draggable={false} />;
      return <button type="button" key={layer.part} className="poster-preview-layer poster-preview-part" style={position} disabled={!interactive}
        aria-label={t("{0}位置", [t(POSTER_PART_LABELS[layer.part])])} aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
        data-dragging={!!live} onPointerDown={(event) => start(event, layer.part, offset)} onPointerMove={move}
        onPointerUp={(event) => end(event, true)} onPointerCancel={(event) => end(event, false)} onLostPointerCapture={(event) => end(event, false)}
        onKeyDown={(event) => {
          const step = ARROW_STEPS[event.key];
          if (!step || drag.current) return;
          event.preventDefault();
          onMove(layer.part, { dx: clamp(offset.dx + step.dx), dy: clamp(offset.dy + step.dy) });
        }}>
        <img src={layer.src} alt="" draggable={false} />
      </button>;
    })}
  </div>;
}

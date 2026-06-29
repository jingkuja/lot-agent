/** Escape text for inclusion in SVG markup. */
function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
}

/**
 * Build a gradient placeholder SVG (used by the mock providers) and return it
 * as a base64 data URL. `kind` only tweaks the caption.
 */
export function placeholderSvgDataUrl(opts: {
  prompt: string;
  width: number;
  height: number;
  kind: "image" | "video";
}): string {
  const { prompt, width, height, kind } = opts;
  const caption = kind === "video" ? "MOCK VIDEO" : "MOCK IMAGE";
  const text = esc(prompt.slice(0, 40) || caption);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#60a5fa"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="50%" y="46%" fill="#ffffff" font-family="sans-serif" font-size="${Math.round(width / 18)}" font-weight="700" text-anchor="middle">${caption}</text>
  <text x="50%" y="58%" fill="#ffffff" font-family="sans-serif" font-size="${Math.round(width / 26)}" text-anchor="middle" opacity="0.9">${text}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export const MINIPROGRAM_CLIENT = "miniprogram";

export interface MiniprogramConfig {
  llm: string;
  image: Record<string, string>;
  imageFallbacks: string[];
}

export const DEFAULT_MINIPROGRAM_CONFIG: MiniprogramConfig = {
  llm: "deepseek-v4-flash",
  // Slot ids sent by the mini program's quality picker:
  //   "1" = 快速   → seedream (cheap/fast)
  //   "2" = 高清   → sunburst (best quality)
  //   "3" = 自动/标准 → flare (middle tier)
  image: {
    "1": "doubao-seedream-5-0-pro",
    "2": "gpt-image-2.5-sunburst",
    "3": "gpt-image-2.5-flare",
  },
  // Universal backup when the preferred model is absent from the user's catalog.
  imageFallbacks: ["gpt-image-2"],
};

export function isMiniprogramClient(header: string | undefined | null): boolean {
  return (header ?? "").trim().toLowerCase() === MINIPROGRAM_CLIENT;
}

export function isMiniprogramImageSlot(
  id: string | undefined,
  cfg: MiniprogramConfig = DEFAULT_MINIPROGRAM_CONFIG
): id is string {
  return !!id && Object.prototype.hasOwnProperty.call(cfg.image, id);
}

export function parseMiniprogramConfig(raw: unknown): MiniprogramConfig {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const imageRaw = src.image && typeof src.image === "object" ? (src.image as Record<string, unknown>) : {};
  const image: Record<string, string> = { ...DEFAULT_MINIPROGRAM_CONFIG.image };
  for (const [slot, value] of Object.entries(imageRaw)) {
    if (typeof value === "string" && value.trim()) image[slot] = value.trim();
  }
  const fallbacks = Array.isArray(src.imageFallbacks)
    ? src.imageFallbacks.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : DEFAULT_MINIPROGRAM_CONFIG.imageFallbacks;
  const llm = typeof src.llm === "string" && src.llm.trim() ? src.llm.trim() : DEFAULT_MINIPROGRAM_CONFIG.llm;
  return { llm, image, imageFallbacks: fallbacks };
}

function inCatalog(catalogIds: string[] | null | undefined, id: string): boolean {
  return (catalogIds ?? []).includes(id);
}

/**
 * Mini program sends slot ids ("1"=快速 / "2"=高清 / "3"=自动·标准). Map them
 * to configured vendor models. When the preferred model is missing from the
 * user's catalog, walk `imageFallbacks` (gpt-image-2) — the per-quality
 * primaries are deliberately NOT interchangeable (seedream is the fast tier,
 * flare/sunburst the quality tiers), so a missing primary falls to the shared
 * backup rather than silently changing the quality tier. Missing catalog
 * keeps the mapped default so generation still proceeds.
 */
export function resolveMiniprogramImageModel(
  slot: string,
  catalogIds: string[] | null | undefined,
  cfg: MiniprogramConfig = DEFAULT_MINIPROGRAM_CONFIG
): string {
  const preferred = cfg.image[slot] ?? cfg.image["2"] ?? DEFAULT_MINIPROGRAM_CONFIG.image["2"];
  if (!catalogIds) return preferred;

  if (inCatalog(catalogIds, preferred)) return preferred;

  for (const id of cfg.imageFallbacks) {
    if (inCatalog(catalogIds, id)) return id;
  }
  return preferred;
}

/**
 * One-step resolution ladder for the sizes the mini program offers, keyed by
 * aspect ratio so a downshift keeps the shape.
 *
 * The fast tier runs on Seedream, which enforces its own pixel window
 * [921,600, 4,624,220] on top of our generic [655,360, 8,294,400] budget —
 * each fast-tier rung is the smallest 16-aligned size for that ratio that
 * still clears Seedream's floor, so the downshift stays legal end to end.
 * The standard tier (flare) has no such floor, but it only ever downshifts
 * the wide ratios anyway. Anything not listed here is returned unchanged.
 */
const SIZE_DOWN_STEP: Record<string, string> = {
  "1920x1088": "1280x720",   // 16:9 → smallest Seedream-legal 16:9
  "1088x1920": "720x1280",   // 9:16
  "1536x1024": "1200x800",   // 3:2
  "1024x1536": "800x1200",   // 2:3
  "1024x1024": "960x960",    // 1:1
};

const WIDE_SIZES = new Set(["1920x1088", "1088x1920"]);

/**
 * The standard tier only touches the expensive wide ratios and does not run on
 * Seedream, so its wide-rung uses a gentler step than the Seedream floor.
 */
const STANDARD_WIDE_DOWN_STEP: Record<string, string> = {
  "1920x1088": "1536x864",
  "1088x1920": "864x1536",
};

/** 快速 (seedream): every ratio drops one step to keep it cheap/fast. */
const FAST_SLOT = "1";
/** 自动 / 标准 (flare): only the expensive wide ratios (16:9 / 9:16) drop. */
const STANDARD_SLOT = "3";

/**
 * Downshift `size` for the given quality slot. Returns the input unchanged for
 * the 高清 slot, unknown sizes, or malformed values — the generation-settings
 * validator stays the single source of truth for what sizes are legal.
 */
export function downshiftMiniprogramImageSize(slot: string, size: string): string {
  if (slot === FAST_SLOT) return SIZE_DOWN_STEP[size] ?? size;
  if (slot === STANDARD_SLOT && WIDE_SIZES.has(size)) return STANDARD_WIDE_DOWN_STEP[size];
  return size;
}

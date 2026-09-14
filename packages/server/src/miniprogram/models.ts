export const MINIPROGRAM_CLIENT = "miniprogram";

export interface MiniprogramConfig {
  llm: string;
  image: Record<string, string>;
  imageFallbacks: string[];
}

export const DEFAULT_MINIPROGRAM_CONFIG: MiniprogramConfig = {
  llm: "deepseek-v4-flash",
  image: {
    "1": "gpt-image-2.5-flare",
    "2": "gpt-image-2.5-sunburst",
  },
  imageFallbacks: ["gpt-image-2", "doubao-seedream-5-0-pro"],
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
 * Mini program sends slot ids ("1" / "2"). Map them to configured vendor
 * models. If neither configured 2.5 model is in the user's catalog, walk
 * `imageFallbacks` in order (gpt-image-2, then seedream). Missing catalog
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

  const primaries = Object.values(cfg.image);
  const hasAnyPrimary = primaries.some((id) => inCatalog(catalogIds, id));
  if (hasAnyPrimary) {
    const other = primaries.find((id) => id !== preferred && inCatalog(catalogIds, id));
    if (other) return other;
  }

  for (const id of cfg.imageFallbacks) {
    if (inCatalog(catalogIds, id)) return id;
  }
  return preferred;
}

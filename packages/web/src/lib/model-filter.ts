export interface CatalogModel {
  id: string;
  type: "llm" | "image" | "video";
  provider: string;
  label?: string;
  description?: string;
}

/** Keep the catalog's existing order while grouping Claude LLMs at the end. */
export function moveClaudeModelsToEnd(models: CatalogModel[]): CatalogModel[] {
  const nonClaude: CatalogModel[] = [];
  const claude: CatalogModel[] = [];
  for (const model of models) {
    (model.id.toLowerCase().includes("claude") ? claude : nonClaude).push(model);
  }
  return [...nonClaude, ...claude];
}

/** gpt-image 1.5 only accepts the three standard sizes; custom WxH is rejected. */
export function isGptImage15(id: string | null | undefined): boolean {
  return /gpt[-_ ]?image[-_ ]?1[\.\-_]?5(?!\d)/i.test(id ?? "");
}

/** gpt-image 2.5 flare — image picker displays this as 默认. */
export function isGptImage25Flare(id: string | null | undefined): boolean {
  return /gpt[-_ ]?image[-_ ]?2[\.\-_]?5[-_ ]?flare/i.test(id ?? "");
}

/** gpt-image 2.5 sunburst — image picker displays this as 旗舰. */
export function isGptImage25Sunburst(id: string | null | undefined): boolean {
  return /gpt[-_ ]?image[-_ ]?2[\.\-_]?5[-_ ]?sunburst/i.test(id ?? "");
}

/** gpt-image 2 (not 2.5). Fallback 默认 when flare/sunburst are both missing. */
export function isGptImage2(id: string | null | undefined): boolean {
  const value = id ?? "";
  if (isGptImage25Flare(value) || isGptImage25Sunburst(value)) return false;
  return /gpt[-_ ]?image[-_ ]?2(?![\.\-_]?5)/i.test(value);
}

const IMAGE_DEFAULT_LABEL = "默认";
const IMAGE_FLAGSHIP_LABEL = "旗舰";

/**
 * Image-generation picker: never show vendor ids.
 * Prefer flare (默认) + sunburst (旗舰); if both are absent, gpt-image-2 as 默认;
 * if none of the three exist, return empty (UI shows 暂无模型).
 */
export function visibleImageModels(models: CatalogModel[]): CatalogModel[] {
  const labeled = (model: CatalogModel, label: string): CatalogModel => ({ ...model, label });
  const flare = models.find((model) => isGptImage25Flare(model.id));
  const sunburst = models.find((model) => isGptImage25Sunburst(model.id));
  const out: CatalogModel[] = [];
  if (flare) out.push(labeled(flare, IMAGE_DEFAULT_LABEL));
  if (sunburst) out.push(labeled(sunburst, IMAGE_FLAGSHIP_LABEL));
  if (out.length > 0) return out;
  const gpt2 = models.find((model) => isGptImage2(model.id));
  return gpt2 ? [labeled(gpt2, IMAGE_DEFAULT_LABEL)] : [];
}

/** Seedance (and only Seedance) auto-adapts duration/ratio from a reference video. */
export function isSeedanceModel(id: string | null | undefined): boolean {
  return (id ?? "").toLowerCase().includes("seedance");
}

/** Kling video models (ids like `kling-video-v3-omni`) use a 720p / 1080p / 4k ladder. */
export function isKlingModel(id: string | null | undefined): boolean {
  return (id ?? "").toLowerCase().startsWith("kling");
}

/** MiniMax H3 Max (ids like `h3-max` / `minimax-video-h3-max`) uses 480P / 768P. */
export function isH3MaxModel(id: string | null | undefined): boolean {
  return /h3[-_ ]?max/i.test(id ?? "");
}

/** MiniMax H3 (ids like `minimax-video-h3`) uses 768P / 2K. Excludes H3 Max. */
export function isMinimaxH3Model(id: string | null | undefined): boolean {
  if (isH3MaxModel(id)) return false;
  return /minimax[-_ ]?(video[-_ ]?)?h3/i.test(id ?? "");
}

/** Seedance 2.5 (ids like `doubao-seedance-2.5` / `doubao-seedance-2-5`). */
export function isSeedance25Model(id: string | null | undefined): boolean {
  return /seedance[^a-z0-9]*2[\.\-_]?5(?!\d)/i.test(id ?? "");
}

export type SeedanceAssetKind = "Image" | "Video" | "Audio";

export function seedanceAssetMention(kind: SeedanceAssetKind, index: number): string {
  return `@${kind}${index + 1}`;
}

/** Mentions required by uploaded assets that are missing from the prompt. */
export function missingSeedanceMentions(
  prompt: string,
  counts: { images?: number; videos?: number; audios?: number }
): string[] {
  const text = prompt.toLowerCase();
  const missing: string[] = [];
  const check = (kind: SeedanceAssetKind, n: number) => {
    for (let i = 0; i < n; i++) {
      const tag = seedanceAssetMention(kind, i);
      if (!text.includes(tag.toLowerCase())) missing.push(tag);
    }
  };
  check("Image", counts.images ?? 0);
  check("Video", counts.videos ?? 0);
  check("Audio", counts.audios ?? 0);
  return missing;
}

/** Case-insensitive substring quick-filter over model id (and label if given). */
export function filterModels(models: CatalogModel[], query: string): CatalogModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) => m.id.toLowerCase().includes(q) || (m.label?.toLowerCase().includes(q) ?? false)
  );
}

export interface CatalogModel {
  id: string;
  type: "llm" | "image" | "video";
  provider: string;
  label?: string;
  description?: string;
}

/** gpt-image 1.5 only accepts the three standard sizes; custom WxH is rejected. */
export function isGptImage15(id: string | null | undefined): boolean {
  return /gpt[-_ ]?image[-_ ]?1[\.\-_]?5(?!\d)/i.test(id ?? "");
}

/** Seedance (and only Seedance) auto-adapts duration/ratio from a reference video. */
export function isSeedanceModel(id: string | null | undefined): boolean {
  return (id ?? "").toLowerCase().includes("seedance");
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

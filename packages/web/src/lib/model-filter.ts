export interface CatalogModel {
  id: string;
  type: "llm" | "image" | "video";
  provider: string;
  label?: string;
  description?: string;
}

/** Seedance (and only Seedance) auto-adapts duration/ratio from a reference video. */
export function isSeedanceModel(id: string | null | undefined): boolean {
  return (id ?? "").toLowerCase().includes("seedance");
}

/** Case-insensitive substring quick-filter over model id (and label if given). */
export function filterModels(models: CatalogModel[], query: string): CatalogModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) => m.id.toLowerCase().includes(q) || (m.label?.toLowerCase().includes(q) ?? false)
  );
}

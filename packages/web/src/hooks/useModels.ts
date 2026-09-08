import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client.js";
import { moveClaudeModelsToEnd, type CatalogModel } from "../lib/model-filter.js";

export type ModelCatalog = { llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] };
const EMPTY: ModelCatalog = { llm: [], image: [], video: [] };

/** Fetch the caller's available models once on mount (server caches ~5min). */
export function useModels() {
  const [models, setModels] = useState<ModelCatalog>(EMPTY);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.listModels();
      const ordered = { ...next, llm: moveClaudeModelsToEnd(next.llm) };
      setModels(ordered);
      return ordered;
    } catch {
      setModels(EMPTY);
      return EMPTY;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { models, loading, reload };
}

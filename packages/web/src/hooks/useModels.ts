import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client.js";
import type { CatalogModel } from "../lib/model-filter.js";

type Catalog = { llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] };
const EMPTY: Catalog = { llm: [], image: [], video: [] };

/** Fetch the caller's available models once on mount (server caches ~5min). */
export function useModels() {
  const [models, setModels] = useState<Catalog>(EMPTY);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    api.listModels().then(setModels).catch(() => setModels(EMPTY)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { models, loading, reload };
}

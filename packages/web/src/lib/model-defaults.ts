import type { CatalogModel } from "./model-filter.js";

export type ModelGroup = "llm" | "image" | "video";

/** 每组各自记住的选中模型;null = 尚未选择(目录为空时保持 null,由服务端默认兜底)。 */
export type SelectedModels = Record<ModelGroup, string | null>;

export const EMPTY_SELECTED: SelectedModels = { llm: null, image: null, video: null };

/** Agent kind → 模型目录分组(文字类 Agent 都用 llm 组)。 */
export function groupForKind(kind: string | undefined): ModelGroup {
  return kind === "image" || kind === "video" ? kind : "llm";
}

/** 只填补还未选择(null)的槽位:取各组接口返回的第一个模型;已有选择保持不变。 */
export function fillModelDefaults(
  prev: SelectedModels,
  catalog: { llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] }
): SelectedModels {
  return {
    llm: prev.llm ?? catalog.llm[0]?.id ?? null,
    image: prev.image ?? catalog.image[0]?.id ?? null,
    video: prev.video ?? catalog.video[0]?.id ?? null,
  };
}

/**
 * 选 llm 组模型:对话已存的模型若仍在目录中则沿用,否则回落到目录第一个。
 * 用于切换 API key / 目录刷新后,避免选中已失效(不在新目录中)的模型。
 */
export function resolveLlmSelection(
  persisted: string | null,
  llmCatalog: CatalogModel[]
): string | null {
  if (persisted && llmCatalog.some((m) => m.id === persisted)) return persisted;
  return llmCatalog[0]?.id ?? null;
}

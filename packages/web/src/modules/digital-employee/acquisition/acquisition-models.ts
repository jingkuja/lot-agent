import type { AcquisitionModelConfiguration, AcquisitionModelOption } from "../types.js";

export const ACQUISITION_MODELS_KEY = "lot:acquisition-media-models";

export function readStoredAcquisitionModels(): { llm?: string; image?: string; video?: string } {
  try {
    const raw = localStorage.getItem(ACQUISITION_MODELS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { llm?: unknown; image?: unknown; video?: unknown };
    return {
      llm: typeof parsed.llm === "string" ? parsed.llm : undefined,
      image: typeof parsed.image === "string" ? parsed.image : undefined,
      video: typeof parsed.video === "string" ? parsed.video : undefined,
    };
  } catch {
    return {};
  }
}

export function writeStoredAcquisitionModels(next: { llm?: string; image?: string; video?: string }) {
  try {
    localStorage.setItem(ACQUISITION_MODELS_KEY, JSON.stringify({ ...readStoredAcquisitionModels(), ...next }));
  } catch {
    // ignore quota / private mode
  }
}

export function listedAcquisitionModels(
  configuration: AcquisitionModelConfiguration | null | undefined,
  kind: "llm" | "image" | "video",
): AcquisitionModelOption[] {
  if (!configuration) return [];
  const listed = kind === "llm" ? configuration.llmModels : kind === "image" ? configuration.imageModels : configuration.videoModels;
  if (listed?.length) return listed;
  const selected = kind === "llm" ? configuration.llmModelId : kind === "image" ? configuration.imageModelId : configuration.videoModelId;
  return selected ? [{ id: selected }] : [];
}

export function pickAcquisitionModel(
  models: AcquisitionModelOption[] | undefined,
  preferred: string | null | undefined,
  fallback: string | null | undefined,
): string {
  const list = models ?? [];
  if (preferred && list.some((model) => model.id === preferred)) return preferred;
  if (fallback && list.some((model) => model.id === fallback)) return fallback;
  return list[0]?.id ?? "";
}

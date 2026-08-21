import type { AcquisitionModelConfiguration, AcquisitionModelOption } from "../types.js";

export const ACQUISITION_MEDIA_MODELS_KEY = "lot:acquisition-media-models";

export function readStoredAcquisitionModels(): { image?: string; video?: string } {
  try {
    const raw = localStorage.getItem(ACQUISITION_MEDIA_MODELS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { image?: unknown; video?: unknown };
    return {
      image: typeof parsed.image === "string" ? parsed.image : undefined,
      video: typeof parsed.video === "string" ? parsed.video : undefined,
    };
  } catch {
    return {};
  }
}

export function writeStoredAcquisitionModels(next: { image?: string; video?: string }) {
  try {
    localStorage.setItem(ACQUISITION_MEDIA_MODELS_KEY, JSON.stringify({ ...readStoredAcquisitionModels(), ...next }));
  } catch {
    // ignore quota / private mode
  }
}

export function listedAcquisitionModels(
  configuration: AcquisitionModelConfiguration | null | undefined,
  kind: "image" | "video",
): AcquisitionModelOption[] {
  if (!configuration) return [];
  const listed = kind === "image" ? configuration.imageModels : configuration.videoModels;
  if (listed?.length) return listed;
  const selected = kind === "image" ? configuration.imageModelId : configuration.videoModelId;
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

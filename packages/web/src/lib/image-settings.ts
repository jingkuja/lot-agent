import { isGptImage15 } from "./model-filter.js";

/** Default image sizes shown in the picker. Custom sizes are allowed except
 * on gpt-image 1.5, which only accepts these three. */
export const IMAGE_PRESETS = [
  { label: "正方形", size: "1024x1024", w: 1, h: 1 },
  { label: "横图", size: "1536x1024", w: 3, h: 2 },
  { label: "竖图", size: "1024x1536", w: 2, h: 3 },
] as const;

export const IMAGE_PRESET_SIZES: readonly string[] = IMAGE_PRESETS.map((p) => p.size);

export const IMAGE_QUALITIES = [
  { label: "自动", value: "auto" },
  { label: "低", value: "low" },
  { label: "中", value: "medium" },
  { label: "高", value: "high" },
] as const;

export const IMAGE_QUALITY_VALUES: readonly string[] = IMAGE_QUALITIES.map((q) => q.value);

export const DEFAULT_IMAGE_SIZE = "1024x1024";
export const DEFAULT_IMAGE_QUALITY = "auto";

/** Vendor (gpt-image) pixel budget. 1024x576 = 589824 is below the minimum. */
export const IMAGE_MIN_PIXELS = 655_360;
export const IMAGE_MAX_PIXELS = 8_294_400;
export const IMAGE_MAX_EDGE = 3840;

export interface ImageSettings {
  size: string;
  n: number;
  quality: string;
}

/** Positive integer from a width/height field. Rejects decimals and signs. */
export function parseDim(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

export function isMultipleOf16(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n % 16 === 0;
}

export function parseImageSize(size: string): { width: number; height: number } | null {
  const matched = /^(\d+)x(\d+)$/.exec(size);
  if (!matched) return null;
  const width = parseDim(matched[1]);
  const height = parseDim(matched[2]);
  if (width == null || height == null) return null;
  return { width, height };
}

export function multipleOf16Error(width: number, height: number): string | null {
  const widthInvalid = !isMultipleOf16(width);
  const heightInvalid = !isMultipleOf16(height);
  if (widthInvalid && heightInvalid) return "宽和高都必须能被 16 整除";
  if (widthInvalid) return "宽度必须能被 16 整除";
  if (heightInvalid) return "高度必须能被 16 整除";
  return null;
}

/** Returns a page-facing error, or null when the size may be submitted. */
export function imageSizeError(size: string, modelId?: string | null): string | null {
  const dim = parseImageSize(size);
  if (!dim) return "请输入有效的分辨率";
  const stepError = multipleOf16Error(dim.width, dim.height);
  if (stepError) return stepError;
  if (dim.width > IMAGE_MAX_EDGE || dim.height > IMAGE_MAX_EDGE) {
    return `边长不能超过 ${IMAGE_MAX_EDGE}`;
  }
  const pixels = dim.width * dim.height;
  if (pixels < IMAGE_MIN_PIXELS) {
    return `分辨率过低，宽×高不能小于 ${IMAGE_MIN_PIXELS} 像素`;
  }
  if (pixels > IMAGE_MAX_PIXELS) {
    return `分辨率过高，宽×高不能大于 ${IMAGE_MAX_PIXELS} 像素`;
  }
  // Any ratio between 1:3 and 3:1 is allowed (inclusive). Only values
  // taller than 1:3 or wider than 3:1 are rejected.
  if (dim.width * 3 < dim.height || dim.height * 3 < dim.width) {
    return "宽高比不能超过 1:3 或 3:1";
  }
  if (isGptImage15(modelId) && !IMAGE_PRESET_SIZES.includes(`${dim.width}x${dim.height}`)) {
    return "当前模型不支持自定义分辨率";
  }
  return null;
}

export function isImagePresetSize(size: string): boolean {
  return IMAGE_PRESET_SIZES.includes(size);
}

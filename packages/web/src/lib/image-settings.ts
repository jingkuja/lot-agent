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

/** Poster remix reserves one upstream reference slot for its selected poster. */
export function imageReferenceCapacity(count: number, posterRemix: boolean) {
  const limit = 5 - Number(posterRemix);
  return { limit, remaining: Math.max(0, limit - count), overflow: count > limit };
}

/** Vendor (gpt-image) pixel budget. 1024x576 = 589824 is below the minimum. */
export const IMAGE_MIN_PIXELS = 655_360;
export const IMAGE_MAX_PIXELS = 8_294_400;
export const IMAGE_MAX_EDGE = 3840;

/** Clarity tiers. The server turns a tier + ratio into a standard pixel size. */
export const IMAGE_RESOLUTIONS = ["1K", "2K", "4K"] as const;
export const DEFAULT_IMAGE_RESOLUTION = "1K";

/** `auto` (智能) follows the first reference image, else 1:1; it is resolved before sending. */
export const IMAGE_AUTO_RATIO = "auto";
export const IMAGE_RATIOS = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export const DEFAULT_IMAGE_RATIO = "1:1";
export const IMAGE_MAX_COUNT = 4;

/** Image types above the composer, in display order (自由创作 first). `count` is the
 * image count a type starts with (the user's own choice per type wins afterwards); `roles` names each image of a set
 * in the order the server writes its prompts (`server/generation/image-scene.ts`); `note` explains what a set costs and
 * the cheaper one-image route through 自由创作. */
export const IMAGE_SCENES = [
  {
    value: "free", label: "自由创作", placeholder: undefined, hint: undefined, note: undefined, count: undefined, roles: undefined,
    needsReference: false,
  },
  {
    value: "poster_remix", label: "爆款复刻", count: undefined, roles: undefined, note: undefined, needsReference: false,
    placeholder: "写下你的品牌名、产品和卖点，也可以上传产品图",
    hint: undefined,
  },
  {
    value: "product_set", label: "产品套图", count: 4, roles: ["封面", "卖点", "使用场景", "细节"], needsReference: false,
    placeholder: "输入产品名和卖点，可上传产品图；如：保温杯，316 不锈钢，12 小时保温，适合通勤",
    hint: "按「图片参数」里的张数依次生成：封面主图、卖点图、使用场景图、细节图",
    note: "每张图单独生成，可再合成为一张，比在一张图里画多格更清晰；按生成张数计费（默认 4 张）。不需要高清时，"
      + "可在「自由创作」里写明“在一张图里拼成四宫格产品套图”，只按 1 张计费。",
  },
  {
    value: "main_images", label: "主副图", count: 2, roles: ["主图", "其他角度", "细节", "使用场景"], needsReference: false,
    placeholder: "输入产品名、特点或想要的风格，可上传产品图；如：白色无线耳机，简约科技风",
    hint: "第 1 张是主图，其余是多角度、细节和使用场景副图；张数在「图片参数」里选择",
    note: "每张图单独生成，可再合成为一张，比在一张图里画多格更清晰；按生成张数计费（默认 2 张）。不需要高清时，"
      + "可在「自由创作」里写明“在一张图里左右拼出主图和副图”，只按 1 张计费。",
  },
  {
    value: "white_background", label: "白底图", count: undefined, roles: undefined, note: undefined, needsReference: false,
    placeholder: "上传产品图或输入产品名，生成纯白背景的商品图；如：红色运动鞋，侧面 45 度",
    hint: "纯白背景、产品居中、柔和棚拍光，适合电商平台上架；出图后自动把背景校正为纯白，并检查商品大小和是否贴边",
  },
  {
    value: "product_scene", label: "换场景", count: undefined, roles: undefined, note: undefined, needsReference: true,
    placeholder: "上传产品实拍图，再写想要的场景；如：放在清晨的木质餐桌上，旁边有咖啡和绿植，自然光",
    hint: "保留你上传的产品，只换背景和场景，适合把实拍图变成场景图；需要先上传产品图",
  },
] as const;
export type ImageScene = typeof IMAGE_SCENES[number]["value"];
export const DEFAULT_IMAGE_SCENE: ImageScene = "free";

export interface PosterReference {
  category: string;
  filename: string;
}

export interface PosterLibraryImage extends PosterReference {
  name: string;
  url: string;
}

/** What image `index` of a set is for (封面 / 卖点 …); undefined for other scenes and for older messages. */
export function imageSetRole(scene: string | undefined, index: number): string | undefined {
  return IMAGE_SCENES.find((item) => item.value === scene)?.roles?.[index];
}

/** Ways to join one generation's images into a single picture, done on the server without a model request. */
export const COMPOSE_LAYOUTS = [
  { value: "vertical", label: "长图", hint: "上下拼接，适合详情页", min: 2 },
  { value: "grid", label: "宫格", hint: "两列排列，适合朋友圈和社媒", min: 2 },
  { value: "hero", label: "一大多小", hint: "第 1 张放大，其余排成一行", min: 3 },
] as const;
export type ComposeLayout = typeof COMPOSE_LAYOUTS[number]["value"];
export const COMPOSE_MIN_IMAGES = 2;
/** Matches the server's limit (`server/generation/compose.ts`). */
export const COMPOSE_MAX_IMAGES = 9;

/** 打包下载 targets. Sizes and file limits live on the server (`server/generation/image-export.ts`); ids must match. */
export const EXPORT_PRESETS = [
  { value: "original", label: "原图" },
  { value: "taobao", label: "淘宝 / 天猫" },
  { value: "pinduoduo", label: "拼多多" },
  { value: "douyin", label: "抖音小店" },
  { value: "shopee", label: "Shopee" },
  { value: "tiktok", label: "TikTok Shop" },
] as const;
export type ExportPreset = typeof EXPORT_PRESETS[number]["value"];

/** 白底图 check per image: whether the background was made pure white, and what may still fail a listing check. */
export type WhiteBackgroundIssue = "busy_background" | "small_subject" | "cropped";
export interface WhiteBackgroundCheck { corrected: boolean; issues: WhiteBackgroundIssue[]; unknown?: boolean }

export const WHITE_BACKGROUND_ISSUES: Record<WhiteBackgroundIssue, string> = {
  busy_background: "背景不是纯白，没能完全校正，平台审核可能不通过，建议重新生成",
  small_subject: "商品在画面中偏小，部分平台要求商品占画面大部分",
  cropped: "商品贴到了画面边缘，可能被裁切",
};

/** White-background checks stored on a message, dropping anything malformed. */
export function whiteBackgroundChecks(raw: unknown): WhiteBackgroundCheck[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item) => {
    const { corrected, issues, unknown } = (item ?? {}) as Record<string, unknown>;
    const known = Array.isArray(issues) ? issues.filter((issue): issue is WhiteBackgroundIssue => issue in WHITE_BACKGROUND_ISSUES) : [];
    return { corrected: corrected === true, issues: known, ...(unknown === true ? { unknown: true } : {}) };
  });
}

/** 重做 one image of a set, or 补齐 the images it is missing. */
export type SetRedoRequest = { index: number; instruction?: string } | { missing: true };
export type RedoRequest = SetRedoRequest | { regenerate: true; requestId: string };

/** A redo in progress on a set (`running`), or the reason the last one made nothing (`failed`). */
export interface GenerationRedo { status: "running" | "failed"; indexes: number[]; taskId?: string; error?: string }

/** The redo stored on a generation message, dropping anything malformed. */
export function generationRedo(raw: unknown): GenerationRedo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { status, indexes, taskId, error } = raw as Record<string, unknown>;
  if (status !== "running" && status !== "failed") return undefined;
  const list = Array.isArray(indexes) ? indexes.filter((index): index is number => Number.isInteger(index) && index >= 0) : [];
  return {
    status, indexes: list,
    ...(typeof taskId === "string" && taskId ? { taskId } : {}),
    ...(typeof error === "string" && error ? { error } : {}),
  };
}

export interface GenerationComposite { url: string; mime: string; layout: ComposeLayout; gap: boolean }

/** Composites stored in message metadata, dropping anything malformed. */
export function generationComposites(raw: unknown): GenerationComposite[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.flatMap((item) => {
    const { url, mime, layout, gap } = (item ?? {}) as Record<string, unknown>;
    const known = COMPOSE_LAYOUTS.find((option) => option.value === layout);
    return typeof url === "string" && url && typeof mime === "string" && known ? [{ url, mime, layout: known.value, gap: gap === true }] : [];
  });
  return list.length ? list : undefined;
}

export interface ImageSettings {
  /** Only on a composer send; generated-image edits never carry a scene. */
  scene?: ImageScene;
  /** Design reference selected from the poster library in 爆款复刻. */
  posterReference?: PosterReference;
  /** 真实字体: the picture is made without text and the wording is typeset on it. Only on a 自由创作 composer send. */
  realText?: boolean;
  /** 1K / 2K / 4K; sent with `ratio` instead of a pixel size. */
  resolution?: string;
  ratio?: string;
  /** Pixel size, kept only for settings stored before tiers existed. */
  size?: string;
  n: number;
  quality: string;
}

/** The listed ratio closest to a width × height (compared on a log scale). */
export function nearestImageRatio(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return DEFAULT_IMAGE_RATIO;
  const target = Math.log(width / height);
  let best: string = DEFAULT_IMAGE_RATIO;
  let bestDistance = Infinity;
  for (const ratio of IMAGE_RATIOS) {
    const [w, h] = ratio.split(":").map(Number);
    const distance = Math.abs(Math.log(w / h) - target);
    if (distance < bestDistance) {
      best = ratio;
      bestDistance = distance;
    }
  }
  return best;
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

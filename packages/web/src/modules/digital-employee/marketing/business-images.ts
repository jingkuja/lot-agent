import type { MarketingVisualAsset } from "../types.js";

export const BUSINESS_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
export const MAX_BUSINESS_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_STORE_PHOTOS = 12;
export const MAX_PRODUCT_IMAGES = 3;

/** Entries saved before logo and store photos had upload slots stay as named links, so saving never drops them. */
export function splitBusinessImages(assets: MarketingVisualAsset[] = []) {
  const logo = assets.find((item) => item.type?.toLowerCase() === "logo") ?? null;
  const photos = assets.filter((item) => item.type?.toLowerCase() === "store");
  const others = assets.filter((item) => item !== logo && item.type?.toLowerCase() !== "store");
  return { logo, photos, others };
}

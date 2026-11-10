import type { MarketingProduct } from "../modules/digital-employee/types.js";

/** The description a product from 获客宝 starts an image request with: its name, positioning and what customers care about. */
export function productPromptText(product: Pick<MarketingProduct, "name" | "positioning" | "coreValues">): string {
  const parts = [product.name.trim(), product.positioning.trim()].filter(Boolean);
  const values = product.coreValues.map((value) => value.trim()).filter(Boolean).slice(0, 3);
  return [parts.join("，"), values.length ? `卖点：${values.join("、")}` : ""].filter(Boolean).join("；");
}

/** The product text goes in front of what the user already typed, once. */
export function withProductText(current: string, text: string): string {
  const typed = current.trim();
  if (!text || typed.includes(text)) return current;
  return typed ? `${text}\n${typed}` : text;
}

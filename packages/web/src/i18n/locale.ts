import { messages } from "./messages.js";

export type Locale = "zh" | "id" | "en";
export const LOCALE_STORAGE_KEY = "lot:language";

// Public configuration is numeric; positive values enable international UI.
export function isInternational(globle: unknown): boolean {
  return typeof globle === "number" && Number.isFinite(globle) && globle > 0;
}

export function resolveLocale(globle: unknown, saved: string | null): Locale {
  if (!isInternational(globle)) return "zh";
  return saved === "zh" || saved === "en" || saved === "id" ? saved : "id";
}

// Some existing services return already-formatted interface status/error strings.
// Match only complete catalog templates at explicit UI call sites; never scan chat content.
const templates = Object.entries(messages).filter(([key]) => /\{\d+\}/.test(key)).map(([key, entry]) => {
  const slots: number[] = [];
  const parts = key.split(/(\{\d+\})/).map((part) => {
    if (/^\{\d+\}$/.test(part)) { slots.push(Number(part.slice(1, -1))); return "([\\s\\S]*?)"; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { pattern: new RegExp(`^${parts.join("")}$`), slots, entry };
});

export function translate<T>(source: T, locale: Locale, values: readonly unknown[] = []): T {
  if (typeof source !== "string") return source;
  const entry = messages[source];
  const text = locale === "zh" ? source : entry?.[locale] ?? source;
  if (locale !== "zh" && !entry && values.length === 0 && source.length <= 2000 && /[\u4e00-\u9fff]/.test(source)) {
    for (const template of templates) {
      const match = template.pattern.exec(source);
      if (!match) continue;
      const captures: unknown[] = [];
      template.slots.forEach((slot, index) => { captures[slot] = match[index + 1]; });
      return template.entry[locale].replace(/\{(\d+)\}/g, (token, index: string) =>
        captures[Number(index)] == null ? token : String(captures[Number(index)])) as T;
    }
  }
  return text.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : match) as T;
}

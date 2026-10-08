import { PPT_ICONS, PPT_LAYOUTS, PPT_THEMES } from "./deck.js";

const text = { type: "string" };
const strings = { type: "array", items: text };
const column = { type: "object", properties: { title: text, bullets: strings }, required: ["title", "bullets"] };
export const PPT_SLIDE_SCHEMA = {
  type: "object",
  properties: {
    layout: { type: "string", enum: [...PPT_LAYOUTS] },
    title: { type: "string", description: "One clear takeaway, max ~44 CJK characters or equivalent Latin width." },
    subtitle: { type: "string", description: "Only for cover/section/closing. Use layout content or notes elsewhere." },
    bullets: { ...strings, description: "content: 1–8 concise points, max ~64 CJK characters per point and 280 total. Put detail in notes." },
    items: { type: "array", items: { type: "object", properties: { label: text, value: text, desc: text, icon: { type: "string", enum: [...PPT_ICONS] } }, required: ["label"] }, description: "agenda: 2–8 labels only; keypoints: 2–6 label/desc/icon; stats: 2–4 short value/label/desc; timeline: 3–6 label/desc. Do not provide fields that the layout cannot display." },
    left: column, right: column,
    quote: { type: "object", properties: { text, author: text }, required: ["text"] },
    chart: {
      type: "object",
      description: "Editable native chart. Use only source-backed data. No invented values or missing values coerced to zero. Pie: one nonnegative series.",
      properties: {
        type: { type: "string", enum: ["bar", "line", "pie"] },
        categories: { ...strings, minItems: 2, maxItems: 8 },
        series: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", properties: { name: text, values: { type: "array", items: { type: "number" } } }, required: ["name", "values"] } },
        unit: text, source: text,
      },
      required: ["type", "categories", "series", "unit", "source"],
    },
    source: { type: "string", description: "Visible evidence/source label. Full references can go in speaker notes." },
    notes: { type: "string", description: "Speaker notes, methodology and detail removed from the slide. Max 4000 characters." },
  },
  required: ["layout", "title"],
};
/** The proposal includes ALL export options so approval cannot silently change the design. */
export const PPT_DECK_SCHEMA = {
  type: "object",
  properties: {
    title: text,
    brief: { type: "object", properties: {
      audience: text, objective: text, durationMinutes: { type: "number", exclusiveMinimum: 0, maximum: 480 }, targetSlides: { type: "integer", minimum: 1, maximum: 40 },
      contentMode: { type: "string", enum: ["generate", "condense", "preserve"] }, assumptions: { ...strings, maxItems: 4 },
    } },
    themePreset: { type: "string", enum: [...PPT_THEMES] },
    templateAssetId: { type: "string", description: "Exact ID from a user upload marker; omit when absent." },
    backgrounds: { type: "array", maxItems: 3, items: { type: "object", properties: { assetId: text, role: { type: "string", enum: ["cover", "body", "section"] }, overlay: { type: "string", enum: ["dark", "light", "none"] } }, required: ["assetId"] } },
    slides: { type: "array", minItems: 1, maxItems: 40, items: PPT_SLIDE_SCHEMA },
  },
  required: ["title", "slides"],
};

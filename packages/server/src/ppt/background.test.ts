import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { renderPptx, type PptOutline } from "./renderer.js";
import { DEFAULT_THEME, type PptTheme } from "./theme-extractor.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("renderPptx background", () => {
  it("embeds a cover background image into the pptx media", async () => {
    const theme: PptTheme = { ...DEFAULT_THEME, backgrounds: { cover: { image: PNG, ext: "png", overlay: "dark" } } };
    const outline: PptOutline = { title: "T", slides: [{ layout: "cover", title: "封面" }] };
    const buf = await renderPptx(outline, theme);
    const zip = await JSZip.loadAsync(buf);
    const media = Object.keys(zip.files).filter((p) => /^ppt\/media\/.*\.(png|jpe?g)$/i.test(p));
    expect(media.length).toBeGreaterThan(0);
    const slide1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(slide1).toContain("封面");
  });
  it("renders fine when no backgrounds set (regression)", async () => {
    const buf = await renderPptx({ title: "T", slides: [{ layout: "content", title: "t", bullets: ["a"] }] }, DEFAULT_THEME);
    const zip = await JSZip.loadAsync(buf);
    expect(zip.file("ppt/slides/slide1.xml")).toBeTruthy();
  });
});

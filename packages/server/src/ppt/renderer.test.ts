import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { renderPptx, type PptOutline } from "./renderer.js";
import { DEFAULT_THEME } from "./theme-extractor.js";

const outline: PptOutline = {
  title: "Roadmap 2026",
  slides: [
    { layout: "cover", title: "Roadmap 2026", bullets: ["Platform Team"] },
    { layout: "section", title: "Part One" },
    { layout: "content", title: "Goals", bullets: ["Ship it", "Measure it"], notes: "presenter note" },
  ],
};

describe("renderPptx", () => {
  it("produces a valid pptx with one slide per outline entry", async () => {
    const buf = await renderPptx(outline, DEFAULT_THEME);
    const zip = await JSZip.loadAsync(buf);
    expect(zip.file("ppt/slides/slide1.xml")).toBeTruthy();
    expect(zip.file("ppt/slides/slide2.xml")).toBeTruthy();
    expect(zip.file("ppt/slides/slide3.xml")).toBeTruthy();
    expect(zip.file("ppt/slides/slide4.xml")).toBeNull();
  });

  it("places titles and bullets into slide xml", async () => {
    const buf = await renderPptx(outline, DEFAULT_THEME);
    const zip = await JSZip.loadAsync(buf);
    const slide3 = await zip.file("ppt/slides/slide3.xml")!.async("string");
    expect(slide3).toContain("Goals");
    expect(slide3).toContain("Ship it");
  });

  it("rejects an empty outline", async () => {
    await expect(
      renderPptx({ title: "x", slides: [] }, DEFAULT_THEME)
    ).rejects.toThrow();
  });
});

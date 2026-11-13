import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { emptyPosterFields, POSTER_TEMPLATES, type PosterLayout } from "@lot-agent/core/poster";
import { contrastRatio, escapeMarkup, initializePosterFonts, posterFontsAvailable, posterPalette, posterRenderKey, pricePieces,
  renderPoster } from "./poster-render.js";

initializePosterFonts();

async function background(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

const fields = {
  ...emptyPosterFields(), title: "火锅店盛大开业，全场 8 折！", subtitle: "正宗重庆牛油锅底", points: ["鲜切牛肉", "手工虾滑"],
  price: "¥199", originalPrice: "¥299", discount: "8 折", date: "11 月 20 日", address: "人民路 88 号 <5 楼> & 6 楼",
};
const layout = (template: PosterLayout["template"], over: Partial<typeof fields> = {}): PosterLayout => ({ version: 1, template, fields: { ...fields, ...over } });

/** Share of pixels in an area that differ clearly from `color`. */
async function inkShare(image: Buffer, area: { left: number; top: number; width: number; height: number }, color: number[]): Promise<number> {
  const { data, info } = await sharp(image).extract(area).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let ink = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (Math.abs(data[i] - color[0]) + Math.abs(data[i + 1] - color[1]) + Math.abs(data[i + 2] - color[2]) > 90) ink++;
  }
  return ink / (info.width * info.height);
}

describe("renderPoster", () => {
  it.each(["新品上市", "Summer collection", "Koleksi baru"])("renders both fonts and weights with distinct styles for %s", async (title) => {
    const backgroundImage = await background(480, 640, "#557766");
    const base = layout("overlay", { title, subtitle: "", points: [], price: "", originalPrice: "", discount: "", date: "", address: "" });
    const old = await renderPoster(backgroundImage, base);
    const hashes = new Set<string>();
    for (const font of ["sans", "serif"] as const) for (const titleWeight of ["regular", "bold"] as const) {
      const styled = { ...base, version: 2, style: { font, titleWeight, scrim: "soft" as const } };
      const rendered = await renderPoster(backgroundImage, styled);
      expect(rendered.overflow).toBe(false);
      expect(rendered.body.equals(old.body)).toBe(false);
      hashes.add(posterRenderKey("bg.png", styled));
    }
    expect(hashes.size).toBe(4);
    expect(posterRenderKey("bg.png", { ...base, style: { font: "sans", titleWeight: "bold", scrim: "auto" } }))
      .toBe(posterRenderKey("bg.png", base));
    const soft = await renderPoster(backgroundImage, { ...base, style: { font: "serif", titleWeight: "bold", scrim: "soft" } });
    const strong = await renderPoster(backgroundImage, { ...base, style: { font: "serif", titleWeight: "bold", scrim: "strong" } });
    expect(soft.body.equals(strong.body)).toBe(false);
  });
  it("finds the bundled fonts", () => {
    expect(posterFontsAvailable()).toBe(true);
  });

  it.each([[1024, 1024], [768, 1024], [576, 1024], [1024, 576]])("typesets every template on a %i×%i canvas without cutting text", async (width, height) => {
    const picture = await background(width, height, "#e9dcc3");
    for (const template of POSTER_TEMPLATES) {
      const rendered = await renderPoster(picture, layout(template));
      const meta = await sharp(rendered.body).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([width, height, "png"]);
      expect(rendered.overflow).toBe(false);
      expect(rendered.body.equals(picture)).toBe(false);
    }
  });

  it("puts the text of a bottom panel in the lower part and leaves the picture above it alone", async () => {
    const picture = await background(800, 1200, "#e9dcc3");
    const rendered = await renderPoster(picture, layout("bottom_panel"));
    expect(await inkShare(rendered.body, { left: 0, top: 0, width: 800, height: 500 }, [233, 220, 195])).toBe(0);
    expect(await inkShare(rendered.body, { left: 0, top: 760, width: 800, height: 440 }, [233, 220, 195])).toBeGreaterThan(0.01);
  });

  it("can leave a panel fully transparent while keeping the text", async () => {
    const picture = await background(800, 1200, "#557766");
    const textOnly = layout("bottom_panel", { subtitle: "", points: [], price: "", originalPrice: "", discount: "", date: "", address: "" });
    const transparent = await renderPoster(picture, { ...textOnly, style: { font: "sans", titleWeight: "bold", scrim: "transparent" } });
    const strong = await renderPoster(picture, { ...textOnly, style: { font: "sans", titleWeight: "bold", scrim: "strong" } });
    const corner = { left: 0, top: 1050, width: 120, height: 100 };
    expect(await inkShare(transparent.body, corner, [85, 119, 102])).toBe(0);
    expect(await inkShare(strong.body, corner, [85, 119, 102])).toBeGreaterThan(0);
    expect(await inkShare(transparent.body, { left: 0, top: 760, width: 800, height: 440 }, [85, 119, 102])).toBeGreaterThan(0.01);
  });

  it("writes light text on a dark picture and dark text on a light one", async () => {
    const title = layout("overlay", { subtitle: "", points: [], price: "", originalPrice: "", discount: "", date: "", address: "" });
    const top = { left: 0, top: 0, width: 800, height: 300 };
    const onDark = await renderPoster(await background(800, 1200, "#101820"), title);
    const onLight = await renderPoster(await background(800, 1200, "#f4efe6"), title);
    const brightest = async (image: Buffer) => (await sharp(image).extract(top).greyscale().stats()).channels[0].max;
    const darkest = async (image: Buffer) => (await sharp(image).extract(top).greyscale().stats()).channels[0].min;
    expect(await brightest(onDark.body)).toBeGreaterThan(240);
    expect(await darkest(onLight.body)).toBeLessThan(60);
  });

  it("reports text that cannot fit instead of failing", async () => {
    const long = "这是一段非常长的文字用来测试放不下的情况".repeat(30);
    const rendered = await renderPoster(await background(600, 600, "#ffffff"), layout("bottom_panel", { subtitle: long, points: [long, long], address: long }));
    expect(rendered.overflow).toBe(true);
    expect((await sharp(rendered.body).metadata()).width).toBe(600);
  });

  it("returns the picture itself when there is no wording", async () => {
    const picture = await background(256, 256, "#336699");
    const rendered = await renderPoster(picture, { version: 1, template: "bottom_panel", fields: emptyPosterFields() });
    expect(await inkShare(rendered.body, { left: 0, top: 0, width: 256, height: 256 }, [51, 102, 153])).toBe(0);
  });

  it("is the same picture for the same layout", async () => {
    const picture = await background(512, 512, "#e9dcc3");
    const [a, b] = await Promise.all([renderPoster(picture, layout("top_panel")), renderPoster(picture, layout("top_panel"))]);
    expect(a.body.equals(b.body)).toBe(true);
  });
});

describe("poster helpers", () => {
  it("escapes characters that would become markup", () => {
    expect(escapeMarkup(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&apos;");
  });

  it("splits a price into its sign, number and unit", () => {
    expect(pricePieces("¥199", true)).toEqual({ before: "¥", number: "199", after: "" });
    expect(pricePieces("199.9 元", true)).toEqual({ before: "", number: "199.9", after: "元" });
    expect(pricePieces("Rp 25.000", false)).toEqual({ before: "Rp", number: "25.000", after: "" });
    expect(pricePieces("199", true).before).toBe("¥");
    expect(pricePieces("199", false).before).toBe("");
    expect(pricePieces("免费", true)).toEqual({ before: "", number: "免费", after: "" });
  });

  it("picks readable text colors for dark and light pictures", () => {
    for (const base of [[20, 24, 32], [240, 236, 225], [128, 128, 128], [200, 30, 30]] as [number, number, number][]) {
      const palette = posterPalette(base);
      expect(contrastRatio(palette.text, palette.panel)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(palette.accent, palette.panel)).toBeGreaterThanOrEqual(3);
    }
  });

  it("keys a render by its background and wording", () => {
    const a = posterRenderKey("bg.png", layout("overlay"));
    expect(posterRenderKey("bg.png", layout("overlay"))).toBe(a);
    expect(posterRenderKey("bg.png", layout("overlay", { price: "¥198" }))).not.toBe(a);
    expect(posterRenderKey("other.png", layout("overlay"))).not.toBe(a);
    expect(posterRenderKey("bg.png", { ...layout("overlay"), overflow: true, cleared: ["date"] })).toBe(a);
  });
});

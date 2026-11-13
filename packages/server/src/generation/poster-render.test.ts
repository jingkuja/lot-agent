import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { emptyPosterFields, POSTER_PARTS, POSTER_TEMPLATES, type PosterLayout } from "@lot-agent/core/poster";
import { contrastRatio, escapeMarkup, initializePosterFonts, posterFontsAvailable, posterPalette, posterRenderKey, pricePieces,
  renderPoster, renderPosterPreview } from "./poster-render.js";

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

  it("writes side panels in columns on the chosen side, and a turned part across", async () => {
    const picture = await background(800, 1200, "#e9dcc3");
    const beige = [233, 220, 195];
    const short = layout("side_panel", { subtitle: "", points: [], price: "", originalPrice: "", discount: "", date: "", address: "" });
    const plain = { font: "sans", titleWeight: "bold", scrim: "transparent" } as const;
    const left = await renderPoster(picture, { ...short, style: plain });
    const right = await renderPoster(picture, { ...short, template: "right_panel", style: plain });
    expect([left.template, right.template, left.overflow, right.overflow]).toEqual(["side_panel", "right_panel", false, false]);
    const leftHalf = { left: 0, top: 0, width: 400, height: 1200 };
    const rightHalf = { left: 400, top: 0, width: 400, height: 1200 };
    expect(await inkShare(left.body, rightHalf, beige)).toBe(0);
    expect(await inkShare(right.body, leftHalf, beige)).toBe(0);
    // A column runs most of the panel's height; turned across, the title takes only a band of it.
    const rows = async (body: Buffer) => {
      let inked = 0;
      for (let top = 0; top < 1200; top += 40) if (await inkShare(body, { left: 0, top, width: 400, height: 40 }, beige) > 0) inked++;
      return inked;
    };
    expect(await rows(left.body)).toBeGreaterThan(15);
    expect(await rows((await renderPoster(picture, { ...short, style: { ...plain, parts: { title: { vertical: false } } } })).body)).toBeLessThan(8);
  });

  it("fits every part in columns without overflow", async () => {
    const picture = await background(768, 1024, "#e9dcc3");
    const parts = Object.fromEntries(POSTER_PARTS.map((part) => [part, { vertical: true }]));
    for (const template of POSTER_TEMPLATES) {
      const rendered = await renderPoster(picture, { ...layout(template), style: { font: "serif", titleWeight: "bold", scrim: "auto", parts } });
      expect(rendered.overflow).toBe(false);
    }
  });

  it("fits a vertical headline in one column despite the planner's horizontal line breaks", async () => {
    const picture = await background(800, 900, "#58758c");
    const draft: PosterLayout = {
      version: 2, template: "overlay", fields: { ...emptyPosterFields(), title: "攀峰登山鞋", subtitle: "加厚防滑，宽松舒适" },
      titleLines: ["攀峰", "登山鞋"], style: { font: "sans", titleWeight: "regular", scrim: "transparent", parts: { title: { vertical: true } } },
    };
    const preview = await renderPosterPreview(picture, draft);
    const title = preview.layers.find((layer) => layer.kind === "text" && layer.part === "title")!;
    expect(title.height / title.width).toBeGreaterThan(4);
    const saved = await renderPoster(picture, draft);
    expect(saved.overflow).toBe(false);
    expect(await inkShare(saved.body, title, [88, 117, 140])).toBeGreaterThan(0.1);
  });

  it("enlarges a vertical title beyond its template area without moving the other text", async () => {
    const picture = await background(800, 900, "#58758c");
    const draft: PosterLayout = {
      version: 2, template: "overlay", fields: { ...emptyPosterFields(), title: "夏日果啤促销贩卖", subtitle: "冰爽果香" },
      style: { font: "sans", titleWeight: "bold", scrim: "transparent", parts: { title: { vertical: true, dx: -40 } } },
    };
    const normal = await renderPosterPreview(picture, draft);
    const edited: PosterLayout = { ...draft, style: { ...draft.style!, parts: { title: { ...draft.style!.parts!.title, fontScale: 200 } } } };
    const larger = await renderPosterPreview(picture, edited);
    const [title, subtitle] = larger.layers;
    expect(title.height).toBeGreaterThan(0.36 * larger.height);
    expect(title.height).toBeGreaterThan(normal.layers[0].height * 1.8);
    expect(title.height / title.width).toBeGreaterThan(7);
    expect(subtitle).toEqual(normal.layers[1]);
    const saved = await renderPoster(picture, edited);
    const movedTitle = { ...title, left: title.left - 320 };
    expect(await inkShare(saved.body, movedTitle, [88, 117, 140])).toBeGreaterThan(0.1);
  });

  it.each(["subtitle", "points", "price", "footer"] as const)("shrinks the %s without changing other parts", async (part) => {
    const picture = await background(800, 900, "#58758c");
    const style = { font: "sans", titleWeight: "bold", scrim: "transparent" } as const;
    const draft = { ...layout("overlay"), style };
    const normal = await renderPosterPreview(picture, draft);
    const smaller = await renderPosterPreview(picture, { ...draft, style: { ...style, parts: { [part]: { fontScale: 60 } } } });
    const isPart = (layer: typeof normal.layers[number]) => layer.kind === "text" && layer.part === part;
    const before = normal.layers.find(isPart)!;
    const after = smaller.layers.find(isPart)!;
    expect(after.width * after.height).toBeLessThan(before.width * before.height * 0.7);
    expect(smaller.layers.filter((layer) => !isPart(layer))).toEqual(normal.layers.filter((layer) => !isPart(layer)));
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

  it("keeps the original background under overlay text in fully transparent mode", async () => {
    const picture = await background(640, 800, "#58758c");
    const draft = layout("overlay", { ...emptyPosterFields(), points: ["加厚防滑", "宽松舒适", "黑色款"] });
    const style = { font: "sans", titleWeight: "bold", scrim: "transparent" } as const;
    const scene = await renderPosterPreview(picture, { ...draft, style });
    expect(scene.layers.map((layer) => layer.kind)).toEqual(["text"]);
    const [text] = scene.layers;
    const { left, top, src } = text;
    const textOnly = await sharp(picture).composite([{ input: Buffer.from(src.split(",")[1], "base64"), left, top }]).png().toBuffer();
    const rendered = await renderPoster(picture, { ...draft, style });
    expect(rendered.body.equals(textOnly)).toBe(true);
    const strong = await renderPosterPreview(picture, { ...draft, style: { ...style, scrim: "strong" } });
    expect(strong.layers.map((layer) => layer.kind)).toEqual(["scrim", "shadow", "text"]);
  });

  it("recolors and nudges one text block on its own", async () => {
    const picture = await background(800, 1200, "#e9dcc3");
    const base = layout("bottom_panel", { subtitle: "", points: [], price: "", originalPrice: "", discount: "", date: "", address: "" });
    const plain = { font: "sans", titleWeight: "bold", scrim: "transparent" } as const;
    const red = await renderPoster(picture, { ...base, style: { ...plain, parts: { title: { color: "#ff0000" } } } });
    const { data } = await sharp(red.body).extract({ left: 0, top: 760, width: 800, height: 440 }).removeAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    let reddish = 0;
    for (let i = 0; i < data.length; i += 3) if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] < 80) reddish++;
    expect(reddish).toBeGreaterThan(100);
    // Moved up by 40% of the height, the title lands in the picture area a plain render leaves alone.
    const moved = await renderPoster(picture, { ...base, style: { ...plain, parts: { title: { dy: -40 } } } });
    const top = { left: 0, top: 0, width: 800, height: 500 };
    expect(await inkShare((await renderPoster(picture, { ...base, style: plain })).body, top, [233, 220, 195])).toBe(0);
    expect(await inkShare(moved.body, top, [233, 220, 195])).toBeGreaterThan(0.005);
    expect(posterRenderKey("bg.png", { ...base, style: { ...plain, parts: { title: { dy: -40 } } } }))
      .not.toBe(posterRenderKey("bg.png", { ...base, style: plain }));
    // A nudge past the canvas edge clips instead of failing.
    const out = await renderPoster(picture, { ...base, style: { ...plain, parts: { title: { dx: 100, dy: 100 } } } });
    expect((await sharp(out.body).metadata()).width).toBe(800);
  });

  it("keeps the same placement and paint order when saving a move from layered preview", async () => {
    const width = 480;
    const height = 640;
    const picture = await background(width, height, "#e9dcc3");
    const draft: PosterLayout = {
      version: 2, template: "overlay", fields: { ...emptyPosterFields(), title: "台灯", subtitle: "新品上市", price: "¥20" },
      style: { font: "sans", titleWeight: "bold", scrim: "strong", parts: { title: { vertical: true }, price: { dy: -35 } } },
    };
    const scene = await renderPosterPreview(picture, draft);
    expect(scene.layers.filter((layer) => layer.kind === "text").map((layer) => layer.part)).toEqual(["title", "subtitle", "price"]);
    const parts = { ...draft.style!.parts, title: { ...draft.style!.parts!.title, dx: -26, dy: 30 } };
    const composed = await sharp(picture).composite(scene.layers.map((layer) => {
      const offset = layer.kind === "scrim" ? undefined : parts[layer.part];
      const left = layer.left + Math.round(width * (offset?.dx ?? 0) / 100);
      const top = layer.top + Math.round(height * (offset?.dy ?? 0) / 100);
      return { input: Buffer.from(layer.src.split(",")[1], "base64"), left, top };
    })).png().toBuffer();
    const saved = await renderPoster(picture, { ...draft, style: { ...draft.style!, parts } });
    expect(saved.body.equals(composed)).toBe(true);
  });

  it("saves a subtitle moved more than half the canvas height into the bottom band", async () => {
    const picture = await background(800, 900, "#58758c");
    const draft = layout("overlay", { ...emptyPosterFields(), title: "攀峰登山鞋", subtitle: "加厚防滑，宽松舒适" });
    const style = { font: "sans", titleWeight: "bold", scrim: "transparent" } as const;
    const saved = await renderPoster(picture, { ...draft, style: { ...style, parts: { subtitle: { dy: 77 } } } });
    const bottom = { left: 0, top: 810, width: 800, height: 90 };
    expect(await inkShare(saved.body, bottom, [88, 117, 140])).toBeGreaterThan(0.03);
    expect(await inkShare((await renderPoster(picture, { ...draft, style })).body, bottom, [88, 117, 140])).toBe(0);
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

  it("does not reuse a previously saved transparent render that still had shadows", () => {
    const style = { font: "sans", titleWeight: "bold", scrim: "transparent" } as const;
    const draft = { ...layout("overlay"), style };
    const oldContent = JSON.stringify(["bg.png", draft.template, draft.fields, null, { version: 2, style }]);
    const oldKey = createHash("sha256").update(oldContent).digest("hex").slice(0, 32);
    expect(posterRenderKey("bg.png", draft)).not.toBe(oldKey);
  });
});

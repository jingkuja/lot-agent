import { describe, expect, it } from "vitest";
import {
  acceptedTitleLines, editPosterLayout, emptyPosterFields, MAX_POSTER_HISTORY, parseAccentRuns, parseManualTitleInput,
  parsePosterExportRatio, parsePosterExportScale, parsePosterLayout, parsePosterPlan, PosterPlanError, posterBackgroundPrompt,
  posterPartVertical, posterTemplateFor, recordPosterVersion, sanitizePosterFields, storedPosters, titleLineOptions, verifyPosterFields,
  parsePosterStyle, DEFAULT_POSTER_STYLE,
} from "./index.js";

const request = "做一张火锅店开业海报，全场 8 折，套餐 199 元，11 月 20 日开业，地址人民路 88 号";

describe("verifyPosterFields", () => {
  it.each([
    ["本周末", "周末促销", false], ["十一月二十日", "十一月二十日开业", true],
    ["11月20日", "11件商品，20元", false], ["this weekend", "sale this weekend", true],
    ["akhir pekan", "promo akhir pekan", true],
  ])("checks full date %s in %s", (date, source, keep) => {
    expect(verifyPosterFields({ ...emptyPosterFields(), date }, source).fields.date).toBe(keep ? date : "");
  });

  it.each([
    ["¥1299", "售价 ￥１，２９９", true], ["Rp25000", "Harga Rp25.000", true],
    ["$2550", "price $25.50", false], ["¥25", "price $25", false], ["8折", "8件", false],
  ])("checks complete amount and unit %s in %s", (price, source, keep) => {
    expect(verifyPosterFields({ ...emptyPosterFields(), price }, source).fields.price).toBe(keep ? price : "");
  });

  it("keeps price roles separate in Chinese, English and Indonesian", () => {
    for (const source of ["原价 ¥299，现价 ¥199", "original price ¥299, now ¥199", "harga normal ¥299; harga promo ¥199"]) {
      const fields = { ...emptyPosterFields(), price: "¥199", originalPrice: "¥299" };
      expect(verifyPosterFields(fields, source).fields).toEqual(fields);
      expect(verifyPosterFields({ ...fields, price: "¥299", originalPrice: "¥199" }, source).fields)
        .toMatchObject({ price: "", originalPrice: "" });
    }
  });
  it("keeps prices, rates and dates whose digits the user wrote", () => {
    const fields = { ...emptyPosterFields(), title: "火锅店盛大开业", price: "199 元", discount: "8 折", date: "11 月 20 日", address: "人民路 88 号" };
    expect(verifyPosterFields(fields, request)).toEqual({ fields, cleared: [] });
  });

  it("empties a price, rate or date the model made up or converted", () => {
    const fields = { ...emptyPosterFields(), title: "开业", price: "¥189", originalPrice: "¥299", discount: "30% OFF", date: "11 月 21 日" };
    const result = verifyPosterFields(fields, request);
    expect(result.fields).toMatchObject({ title: "开业", price: "", originalPrice: "", discount: "", date: "" });
    expect(result.cleared).toEqual(["price", "originalPrice", "discount", "date"]);
  });

  it("matches whole numbers, full-width digits and worded rates", () => {
    expect(verifyPosterFields({ ...emptyPosterFields(), price: "19" }, "原价 199").cleared).toEqual(["price"]);
    expect(verifyPosterFields({ ...emptyPosterFields(), price: "１９９" }, "只要 199").cleared).toEqual([]);
    expect(verifyPosterFields({ ...emptyPosterFields(), discount: "半价" }, "周末半价").cleared).toEqual([]);
    expect(verifyPosterFields({ ...emptyPosterFields(), discount: "半价" }, "周末特惠").cleared).toEqual(["discount"]);
  });

  it("drops a selling point or headline carrying a price the user did not give, and keeps other numbers", () => {
    const fields = { ...emptyPosterFields(), title: "立减 50 元", subtitle: "24 小时营业", points: ["12 小时保温", "低至 5 折"] };
    const result = verifyPosterFields(fields, "保温杯海报");
    expect(result.fields).toMatchObject({ title: "", subtitle: "24 小时营业", points: ["12 小时保温"] });
    expect(result.cleared).toEqual(["title", "points"]);
  });
});

describe("title lines", () => {
  it("accepts suggested lines only when they spell the title and no line is one character", () => {
    expect(acceptedTitleLines("火锅店盛大开业", ["火锅店", "盛大开业"])).toEqual(["火锅店", "盛大开业"]);
    expect(acceptedTitleLines("火锅店盛大开业", ["火锅店", "隆重开业"])).toBeUndefined();
    expect(acceptedTitleLines("全场八折", ["全", "场八折"])).toBeUndefined();
  });

  it("offers balanced breaks after punctuation and never a single-character line", () => {
    const options = titleLineOptions("火锅店盛大开业，全场 8 折！");
    expect(options[0]).toEqual(["火锅店盛大开业，全场 8 折！"]);
    expect(options).toContainEqual(["火锅店盛大开业，", "全场 8 折！"]);
    for (const lines of options) for (const line of lines) expect(Array.from(line).length).toBeGreaterThan(1);
    expect(titleLineOptions("开业")).toEqual([["开业"]]);
  });
});

describe("parsePosterPlan", () => {
  const reply = JSON.stringify({
    background: "A steaming hot pot on a wooden table", template: "overlay", title: "火锅店盛大开业", titleLines: ["火锅店", "盛大开业"],
    subtitle: "", points: ["鲜切牛肉"], price: "199 元", originalPrice: "299 元", discount: "8 折", date: "", address: "人民路 88 号",
  });

  it("reads the picture prompt and wording, emptying numbers that are not in the request", () => {
    const plan = parsePosterPlan("```json\n" + reply + "\n```", request);
    expect(plan.background).toBe("A steaming hot pot on a wooden table");
    expect(plan.layout).toMatchObject({
      template: "overlay", titleLines: ["火锅店", "盛大开业"], cleared: ["originalPrice"],
      fields: { title: "火锅店盛大开业", points: ["鲜切牛肉"], price: "199 元", originalPrice: "", discount: "8 折", address: "人民路 88 号" },
    });
  });

  it("fails on a reply without a picture prompt or that is not JSON", () => {
    expect(() => parsePosterPlan('{"title": "开业"}', request)).toThrow(PosterPlanError);
    expect(() => parsePosterPlan("好的，这是海报", request)).toThrow(PosterPlanError);
  });

  it("falls back to the default template and strips line breaks and overlong text", () => {
    const plan = parsePosterPlan(JSON.stringify({ background: "x", template: "spiral", title: `开业\n${"大".repeat(80)}` }), request);
    expect(plan.layout.template).toBe("overlay");
    expect(plan.layout.fields.title).not.toContain("\n");
    expect(Array.from(plan.layout.fields.title).length).toBe(40);
  });
});

describe("layout helpers", () => {
  it("round-trips versioned styles, keeps old defaults, and ignores unknown fonts and markup", () => {
    const old = parsePosterLayout({ version: 1, template: "overlay", fields: { title: "旧海报" } })!;
    expect(old.version).toBe(2);
    expect(parsePosterStyle(old.style)).toEqual(DEFAULT_POSTER_STYLE);
    const style = { font: "serif", titleWeight: "regular", scrim: "transparent" } as const;
    const edited = editPosterLayout(old, { style });
    expect(parsePosterLayout(JSON.parse(JSON.stringify(edited)))?.style).toEqual(style);
    expect(editPosterLayout(edited, { fields: { title: "手动输入价格¥888" } }).style).toEqual(style);
    expect(editPosterLayout(edited, { style: { font: '<span font_desc="evil">', titleWeight: 999, scrim: "invisible" } }).style)
      .toEqual(DEFAULT_POSTER_STYLE);
  });
  it("keeps valid per-part colors and nudges, clamps them, and migrates legacy footer", () => {
    const style = parsePosterStyle({
      accentColor: "#FF5500",
      parts: {
        title: { color: "#FF0000", dx: 3.4, dy: -180, letterSpacing: 15, lineSpacing: 140, stroke: "medium", strokeColor: "#112233" },
        subtitle: { color: "red", dx: 0, dy: 76.4, letterSpacing: -50, lineSpacing: 500, stroke: "thick", strokeColor: "#112233" },
        points: { dy: "5", stroke: "none", strokeColor: "#112233" },
        price: { color: '#000000" font_desc="x' },
        footer: { dx: 200, color: "#00ff00" },
        date: { dx: 12 },
        nope: { dx: 4 },
      },
    });
    expect(style.accentColor).toBe("#ff5500");
    expect(style.parts).toEqual({
      title: { color: "#ff0000", dx: 3, dy: -100, letterSpacing: 15, lineSpacing: 140, stroke: "medium", strokeColor: "#112233" },
      subtitle: { dy: 76, letterSpacing: -10, lineSpacing: 200 },
      date: { color: "#00ff00", dx: 12 },
      address: { color: "#00ff00", dx: 100 },
    });
    expect(parsePosterStyle({ accentColor: "orange", parts: { title: { dx: 0, letterSpacing: 0, lineSpacing: 100 } } }))
      .toEqual(DEFAULT_POSTER_STYLE);
    expect(parsePosterStyle({ parts: { title: { vertical: false }, subtitle: { vertical: "yes" } } }).parts)
      .toEqual({ title: { vertical: false } });
  });

  it("parses accent keyword spans, manual title breaks and avoids splitting inside brackets", () => {
    expect(parseAccentRuns("火锅店【盛大开业】全场【8折】")).toEqual([
      { text: "火锅店", accent: false }, { text: "盛大开业", accent: true },
      { text: "全场", accent: false }, { text: "8折", accent: true },
    ]);
    expect(parseAccentRuns("未闭合【括号")).toEqual([{ text: "未闭合【括号", accent: false }]);
    expect(parseManualTitleInput("夏日冰饮|第二杯半价")).toEqual({
      title: "夏日冰饮第二杯半价", titleLines: ["夏日冰饮", "第二杯半价"], manualTitleLines: true,
    });
    expect(parseManualTitleInput("Summer\nSale")).toEqual({
      title: "Summer Sale", titleLines: ["Summer", "Sale"], manualTitleLines: true,
    });
    expect(titleLineOptions("夏日冰饮第二杯半价", ["夏日冰饮", "第二杯半价"], true)).toEqual([["夏日冰饮", "第二杯半价"]]);
    const options = titleLineOptions("火锅店【盛大开业】");
    for (const lines of options) {
      for (const item of lines) {
        expect((item.match(/【/g) ?? []).length).toBe((item.match(/】/g) ?? []).length);
      }
    }
  });

  it("writes side panels in columns unless the user turned a part", () => {
    const style = parsePosterStyle({ parts: { title: { vertical: false }, price: { vertical: true } } });
    expect(posterPartVertical(style, "title", "right_panel")).toBe(false);
    expect(posterPartVertical(style, "subtitle", "side_panel")).toBe(true);
    expect(posterPartVertical(style, "subtitle", "top_panel")).toBe(false);
    expect(posterPartVertical(style, "price", "bottom_panel")).toBe(true);
  });

  it("round-trips manual sizes and treats invalid or default sizes as automatic", () => {
    const stored = parsePosterLayout({ template: "overlay", fields: { title: "新品上市" } })!;
    const edited = editPosterLayout(stored, { style: { parts: {
      title: { fontScale: 169.6, vertical: true }, subtitle: { fontScale: 999 }, points: { fontScale: 1 },
      price: { fontScale: 100 }, footer: { fontScale: "120" },
    } } });
    expect(parsePosterLayout(edited)?.style?.parts).toEqual({
      title: { fontScale: 170, vertical: true }, subtitle: { fontScale: 300 }, points: { fontScale: 50 },
    });
  });

  it("fits the template to the canvas shape", () => {
    expect(posterTemplateFor("side_panel", 1024, 1536)).toBe("side_panel");
    expect(posterTemplateFor("right_panel", 1024, 1536)).toBe("right_panel");
    expect(posterTemplateFor("bottom_panel", 1536, 864)).toBe("side_panel");
    expect(posterTemplateFor("top_panel", 1024, 1024)).toBe("top_panel");
    expect(posterTemplateFor("overlay", 1536, 864)).toBe("overlay");
  });

  it.each([
    ["bottom_panel", "bottom 40%"], ["overlay", "bottom 25%"],
  ] as const)("reserves space on a continuous, text-free background for %s", (template, space) => {
    const prompt = posterBackgroundPrompt("A hot pot", template);
    expect(prompt).toContain("A hot pot");
    expect(prompt).toContain(space);
    expect(prompt).toContain("same surfaces, texture and detail");
    expect(prompt).toContain("Do not add panels, color bands, haze, blur or gradient overlays");
    expect(prompt).toContain("no text");
  });

  it("applies a user's edit, trusting their text and dropping stale notes", () => {
    const stored = parsePosterLayout({
      template: "bottom_panel", fields: { title: "火锅店盛大开业" }, titleLines: ["火锅店", "盛大开业"], cleared: ["price"],
      background: { url: "/static/assets/bg.png" }, overflow: true,
    })!;
    const same = editPosterLayout(stored, { fields: { ...stored.fields, price: "¥99" }, template: "overlay" });
    expect(same).toEqual({
      version: 2, template: "overlay", fields: { ...stored.fields, price: "¥99" }, titleLines: ["火锅店", "盛大开业"], background: { url: "/static/assets/bg.png" },
    });
    expect(editPosterLayout(stored, { fields: { ...stored.fields, title: "新店开业" } }).titleLines).toBeUndefined();
    const manual = editPosterLayout(stored, { fields: { ...stored.fields, title: "火锅店|盛大|开业" } });
    expect(manual).toMatchObject({
      fields: { title: "火锅店盛大开业" }, titleLines: ["火锅店", "盛大", "开业"], manualTitleLines: true,
    });
    expect(parsePosterLayout(manual)).toMatchObject({ titleLines: ["火锅店", "盛大", "开业"], manualTitleLines: true });
  });

  it("reads stored posters and ignores anything malformed", () => {
    expect(storedPosters([{ template: "overlay", fields: { title: "开业" } }, { template: "nope" }])).toMatchObject([{ template: "overlay" }, null]);
    expect(storedPosters([null])).toBeUndefined();
    expect(storedPosters("x")).toBeUndefined();
    expect(sanitizePosterFields({ points: ["a", "", 3, "b", "c", "d", "e"] }).points).toEqual(["a", "b", "c", "d"]);
  });

  it("supports per-part fonts, rotation, version history recording/capping, background meta and export options", () => {
    expect(parsePosterStyle({
      parts: {
        title: { font: "serif", rotate: 15 },
        subtitle: { font: "comic", rotate: 0 },
        price: { rotate: -240 },
      },
    }).parts).toEqual({ title: { font: "serif", rotate: 15 }, price: { rotate: -180 } });
    expect(parsePosterExportRatio(undefined)).toBe("original");
    expect(parsePosterExportRatio("9:16")).toBe("9:16");
    expect(parsePosterExportRatio("99:1")).toBeNull();
    expect(parsePosterExportScale(2)).toBe(2);
    expect(parsePosterExportScale(4)).toBe(1);
    let layout = parsePosterLayout({
      template: "overlay", fields: { title: "v0" }, backgroundPrompt: "warm table", backgroundSuspect: true,
    })!;
    for (let i = 0; i < MAX_POSTER_HISTORY + 3; i++) {
      const history = recordPosterVersion(layout, { url: `/static/assets/p${i}.png`, mime: "image/png" }, `2026-11-14T11:0${i}:00Z`);
      layout = { ...layout, fields: { ...layout.fields, title: `v${i + 1}` }, history };
    }
    expect(layout.history).toHaveLength(MAX_POSTER_HISTORY);
    expect(layout.history?.[0].asset.url).toBe(`/static/assets/p${MAX_POSTER_HISTORY + 2}.png`);
    const parsed = parsePosterLayout({ ...layout, history: [...(layout.history ?? []), { bad: true }] })!;
    expect(parsed.history).toHaveLength(MAX_POSTER_HISTORY);
    expect(parsed.backgroundPrompt).toBe("warm table");
    expect(parsed.backgroundSuspect).toBe(true);
  });
});

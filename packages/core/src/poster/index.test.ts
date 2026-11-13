import { describe, expect, it } from "vitest";
import {
  acceptedTitleLines, editPosterLayout, emptyPosterFields, parsePosterLayout, parsePosterPlan, PosterPlanError, posterBackgroundPrompt,
  posterTemplateFor, sanitizePosterFields, storedPosters, titleLineOptions, verifyPosterFields, parsePosterStyle, DEFAULT_POSTER_STYLE,
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
  it("keeps valid per-part colors and nudges, clamps them, and drops anything else", () => {
    const style = parsePosterStyle({
      parts: {
        title: { color: "#FF0000", dx: 3.4, dy: -80 }, subtitle: { color: "red", dx: 0 }, points: { dy: "5" },
        price: { color: '#000000" font_desc="x' }, footer: { dx: -2 }, nope: { dx: 4 },
      },
    });
    expect(style.parts).toEqual({ title: { color: "#ff0000", dx: 3, dy: -50 }, footer: { dx: -2 } });
    expect(parsePosterStyle({ parts: { title: { dx: 0 } } })).toEqual(DEFAULT_POSTER_STYLE);
  });

  it("fits the template to the canvas shape", () => {
    expect(posterTemplateFor("side_panel", 1024, 1536)).toBe("bottom_panel");
    expect(posterTemplateFor("bottom_panel", 1536, 864)).toBe("side_panel");
    expect(posterTemplateFor("top_panel", 1024, 1024)).toBe("top_panel");
    expect(posterTemplateFor("overlay", 1536, 864)).toBe("overlay");
  });

  it("adds the template's room and the no-text rule to the picture prompt", () => {
    const prompt = posterBackgroundPrompt("A hot pot", "bottom_panel");
    expect(prompt).toContain("A hot pot");
    expect(prompt).toContain("bottom 40%");
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
  });

  it("reads stored posters and ignores anything malformed", () => {
    expect(storedPosters([{ template: "overlay", fields: { title: "开业" } }, { template: "nope" }])).toMatchObject([{ template: "overlay" }, null]);
    expect(storedPosters([null])).toBeUndefined();
    expect(storedPosters("x")).toBeUndefined();
    expect(sanitizePosterFields({ points: ["a", "", 3, "b", "c", "d", "e"] }).points).toEqual(["a", "b", "c", "d"]);
  });
});

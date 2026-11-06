import { describe, expect, it } from "vitest";
import type { MarketingProduct } from "./marketing-types.js";
import {
  applyImportEdits, buildImportDraft, importUserPrompt, importedFields, parseImportOutput, unsourcedNumbers,
  type ImportDraft, type ImportModelProduct,
} from "./product-import.js";

const entry = (over: Partial<ImportModelProduct> = {}): ImportModelProduct => ({
  name: "小店", suggestedName: "", existing: "", positioning: "", coreValues: [], facts: [], benefits: [], objections: [], faqs: [],
  prohibited: [], cases: [], notes: "", questions: [], ...over,
});

const product = (over: Partial<MarketingProduct> = {}) => ({
  id: "m1", name: "API 网关", positioning: "", coreValues: [], verifiableFacts: [], commonObjections: [], currentBenefits: [],
  prohibitedExpressions: [], caseMaterials: [], faqs: [], productNotes: "", version: 1, ...over,
}) as MarketingProduct;

interface BuildOptions { sourceText?: string; catalog?: MarketingProduct[]; target?: MarketingProduct | null }

const build = (entries: ImportModelProduct[], over: BuildOptions = {}) => buildImportDraft(entries, {
  documentId: "d1", title: "手册.docx", sourceText: over.sourceText ?? "", truncated: false, skippedPages: 0,
  catalog: over.catalog ?? [], target: over.target ?? null, now: new Date("2026-11-06T00:00:00Z"),
});

describe("parseImportOutput", () => {
  it("accepts fenced JSON and drops incomplete items", () => {
    const [parsed] = parseImportOutput('```json\n{"products":[{"name":"A","facts":[{"statement":"价 1"},{"source":"p1"}],"faqs":[{"question":"问"}]}]}\n```');
    expect(parsed).toMatchObject({ name: "A", facts: [{ statement: "价 1" }], faqs: [] });
  });

  it("fails rather than produce an empty review", () => {
    expect(() => parseImportOutput('{"products":[]}')).toThrow("no products");
    expect(() => parseImportOutput("sorry")).toThrow(SyntaxError);
  });

  it("drops a date the model did not format", () => {
    const [parsed] = parseImportOutput('{"products":[{"name":"A","benefits":[{"title":"优惠","validUntil":"月底"}]}]}');
    expect(parsed.benefits[0].validUntil).toBeNull();
  });
});

describe("unsourcedNumbers", () => {
  it.each([
    ["1,280 元", "单次价 1280 元"],
    ["1280 元", "单次价 1,280 元"],
    ["150 元", "防水涂料,桶,168,150,送滚刷"],
    ["6.50", "PPR水管 6.5"],
    ["９９ 元", "体验价 99 元"],
  ])("accepts %s found in %s", (text, source) => {
    expect(unsourcedNumbers(text, source)).toEqual([]);
  });

  it("reports a figure the file does not contain", () => {
    expect(unsourcedNumbers("月费 30 元，首月 25 元", "月费三十元，首月 25 元")).toEqual(["30"]);
  });
});

describe("buildImportDraft", () => {
  it("keeps items that need the owner out of the default save", () => {
    const { products } = build([entry({
      facts: [{ statement: "单次 198 元" }, { statement: "年费 999 元" }, { statement: "电话 13812345678" }],
      benefits: [{ title: "新客 99 元" }, { title: "开业 8 折", validUntil: "2025-10-07" }],
    })], { sourceText: "单次 198 元 新客 99 元 电话 13812345678 开业 8 折 2025 10 7" });
    expect(products[0].items.map(({ text, selected, flag }) => [text, selected, flag])).toEqual([
      ["单次 198 元", true, undefined],
      ["年费 999 元", false, "number"],
      ["电话 13812345678", false, "contact"],
      ["新客 99 元", false, "benefit"],
      ["开业 8 折", false, "expired"],
    ]);
  });

  it("matches a loosely written existing product and leaves its positioning alone", () => {
    const current = product({ positioning: "已有定位", coreValues: ["已有"], verifiableFacts: [{ statement: "已有事实" }] });
    const { products } = build([entry({
      name: "API网关", positioning: "新定位", coreValues: ["新卖点"], facts: [{ statement: "已有事实" }, { statement: "新事实" }],
    })], { catalog: [current] });
    expect(products[0]).toMatchObject({ targetProductId: "m1", name: "API 网关", positioning: "" });
    expect(products[0].items.map((item) => item.text)).toEqual(["新事实"]);
  });

  it("fills blanks on a product that has none", () => {
    const { products } = build([entry({ existing: "API 网关", positioning: "新定位", coreValues: ["新卖点"] })], { catalog: [product()] });
    expect(products[0].positioning).toBe("新定位");
    expect(products[0].items.map((item) => item.text)).toEqual(["新卖点"]);
  });

  it("treats a name that adds to an existing one as new", () => {
    expect(build([entry({ name: "API 网关增强版" })], { catalog: [product()] }).products[0].targetProductId).toBeNull();
  });

  it("uses the owner's product for every entry when they chose one", () => {
    const { products } = build([entry({ name: "别的" }), entry({ name: "再一个" })], { target: product({ positioning: "x" }), catalog: [] });
    expect(products).toHaveLength(1);
    expect(products[0].targetProductId).toBe("m1");
  });

  it("says shared shop facts once across products", () => {
    const shared = { facts: [{ statement: "周一休息" }] };
    const { products } = build([entry({ name: "A", ...shared }), entry({ name: "B", ...shared })]);
    expect(products.map((item) => item.items.length)).toEqual([1, 0]);
  });

  it("caps questions per file but never drops the one asking for a name", () => {
    const ask = (count: number) => Array.from({ length: count }, (_, index) => ({ field: "notes", question: `问${index}` }));
    const { products } = build([entry({ questions: ask(5) }), entry({ name: "", questions: ask(2) })]);
    expect(products[0].questions).toHaveLength(3);
    expect(products[1].questions.map((item) => item.field)).toEqual(["name"]);
  });

  it("names a product after the file when the model suggests nothing", () => {
    expect(build([entry({ name: "" })]).products[0].suggestedName).toBe("手册");
  });

  it("does not treat a mislabelled question as asking for the name", () => {
    const { products } = build([entry({ questions: [{ field: "name", question: "还有别的项目吗？" }] })]);
    expect(products[0].questions[0].field).toBe("notes");
  });
});

describe("applyImportEdits", () => {
  const draft: ImportDraft = {
    documentId: "d1", title: "t", truncated: false, skippedPages: 0,
    products: [
      {
        key: "p1", name: "", suggestedName: "小店", targetProductId: null, targetName: null, positioning: "",
        items: [
          { id: "p1-1", field: "verifiableFacts", text: "事实", selected: true },
          { id: "p1-2", field: "currentBenefits", text: "优惠", selected: false, flag: "benefit" },
        ],
        questions: [
          { id: "p1-q1", field: "name", question: "叫什么" },
          { id: "p1-q2", field: "positioning", question: "给谁用" },
          { id: "p1-q3", field: "notes", question: "怎么买" },
        ],
      },
      { key: "p2", name: "B", suggestedName: "", targetProductId: null, targetName: null, positioning: "", items: [], questions: [] },
    ],
  };

  it("routes each answer to its field and ignores blanks", () => {
    const [first] = applyImportEdits(draft, {
      answers: [{ id: "p1-q1", answer: "小店" }, { id: "p1-q2", answer: "老人" }, { id: "p1-q3", answer: "  " }],
    });
    expect(first).toMatchObject({ name: "小店", positioning: "老人" });
    expect(first.items).toHaveLength(2);
  });

  it("falls back to the suggested name", () => {
    expect(applyImportEdits(draft, {})[0].name).toBe("小店");
  });

  it("turns other answers into notes", () => {
    const [first] = applyImportEdits(draft, { answers: [{ id: "p1-q3", answer: "微信" }] });
    expect(first.items.at(-1)).toMatchObject({ field: "productNotes", text: "怎么买 微信", selected: true });
  });

  it("applies chat approvals, rejections and skipped products", () => {
    const products = applyImportEdits(draft, { confirmItemIds: ["p1-2"], skipItemIds: ["p1-1"], products: [{ key: "p2", skip: true }] });
    expect(products).toHaveLength(1);
    expect(products[0].items.map((item) => item.selected)).toEqual([false, true]);
  });

  it("cannot add an item the draft does not hold", () => {
    const [first] = applyImportEdits(draft, { products: [{ key: "p1", items: [{ id: "forged", selected: true, text: "编的" }] }] });
    expect(first.items.map((item) => item.id)).toEqual(["p1-1", "p1-2"]);
  });
});

describe("importedFields", () => {
  const sorted = (items: Array<[string, string]>) => ({
    key: "p1", name: "A", suggestedName: "", targetProductId: null, targetName: null, positioning: "新定位", questions: [],
    items: items.map(([field, text], index) => ({ id: `i${index}`, field, text, selected: true })),
  }) as never;

  it("records where a fact came from", () => {
    const item = { id: "i", field: "verifiableFacts", text: "事实", source: "第 2 页", selected: true };
    const { fields } = importedFields({ ...(sorted([]) as object), items: [item] } as never, "手册", null);
    expect(fields.verifiableFacts).toEqual([{ statement: "事实", evidence: "手册 · 第 2 页" }]);
  });

  it("appends to what exists, keeps a positioning, and counts what did not fit", () => {
    const full = Array.from({ length: 30 }, (_, index) => `卖点${index}`);
    const { fields, dropped } = importedFields(sorted([["coreValues", "再一个"], ["productNotes", "新说明"]]), "t", product({
      coreValues: full, positioning: "原定位", productNotes: "原说明",
    }));
    expect(fields).toEqual({ productNotes: "原说明\n\n新说明" });
    expect(dropped).toBe(1);
  });

  it("writes nothing when the product already says it", () => {
    expect(importedFields(sorted([["faqs", "问题"]]), "t", product({ positioning: "x", faqs: [{ question: "问题", answer: "答" }] })).fields).toEqual({});
  });
});

describe("importUserPrompt", () => {
  it("shows the model only the start of a long file, and only the target when chosen", () => {
    const value = JSON.parse(importUserPrompt({ title: "t", text: "字".repeat(70_000), catalog: ["A"], target: product() as never }));
    expect(value.file).toHaveLength(60_000);
    expect(value.catalog).toBeUndefined();
    expect(value.target.name).toBe("API 网关");
  });
});

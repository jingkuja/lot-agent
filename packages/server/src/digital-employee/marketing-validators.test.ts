import { describe, expect, it } from "vitest";
import { InputError } from "./errors.js";
import {
  parseMarketingBrandAssets,
  parseMarketingProduct,
  parseMarketingProductList,
  parseMarketingProductUpdate,
} from "./marketing-validators.js";

describe("parseMarketingProduct", () => {
  it("解析完整产品资料并裁剪空白", () => {
    const result = parseMarketingProduct({
      name: "  会员版  ",
      positioning: " 一体化会员经营 ",
      coreValues: ["省心", "省心"],
      verifiableFacts: [{ statement: "支持7天无理由退订", evidence: "官网公告" }],
      commonObjections: [{ objection: "价格高", response: "按季度付有折扣" }],
      currentBenefits: [{ title: "首月免单", validFrom: "2026-08-01", validUntil: "2026-09-01" }],
      prohibitedExpressions: ["最强"],
      caseMaterials: [{ title: "制造企业案例", summary: "3 周上线", assetUrl: "/static/assets/case.png" }],
    });
    expect(result.name).toBe("会员版");
    expect(result.positioning).toBe("一体化会员经营");
    expect(result.coreValues).toEqual(["省心"]);
    expect(result.verifiableFacts).toEqual([{ statement: "支持7天无理由退订", evidence: "官网公告" }]);
    expect(result.currentBenefits).toEqual([{ title: "首月免单", validFrom: "2026-08-01T00:00:00.000Z", validUntil: "2026-09-01T00:00:00.000Z" }]);
    expect(result.caseMaterials).toEqual([{ title: "制造企业案例", summary: "3 周上线", assetUrl: "/static/assets/case.png" }]);
  });

  it("拒绝非对象请求体与缺失产品名称", () => {
    expect(() => parseMarketingProduct(null)).toThrow(InputError);
    expect(() => parseMarketingProduct([])).toThrow(InputError);
    expect(() => parseMarketingProduct({ positioning: "x" })).toThrow("产品名称不能为空");
    expect(() => parseMarketingProduct({ name: "   " })).toThrow("产品名称格式无效");
  });

  it("拒绝禁用表达重复项并保留首个顺序", () => {
    const result = parseMarketingProduct({ name: "会员版", prohibitedExpressions: ["最强", "第一", "最强"] });
    expect(result.prohibitedExpressions).toEqual(["最强", "第一"]);
  });

  it("拒绝权益结束时间早于开始时间", () => {
    expect(() => parseMarketingProduct({
      name: "会员版",
      currentBenefits: [{ title: "首月免单", validFrom: "2026-09-01", validUntil: "2026-08-01" }],
    })).toThrow("权益结束时间不能早于开始时间");
  });

  it("把空字符串日期归一化为 null 并接受空权益窗口", () => {
    const result = parseMarketingProduct({ name: "会员版", currentBenefits: [{ title: "长期折扣", validFrom: "", validUntil: "" }] });
    expect(result.currentBenefits).toEqual([{ title: "长期折扣", validFrom: null, validUntil: null }]);
  });

  it("只允许HTTP(S)或站内路径的素材与视觉资产链接", () => {
    expect(parseMarketingProduct({
      name: "会员版",
      caseMaterials: [{ title: "案例", summary: "摘要", assetUrl: "https://cdn.example.com/case.png" }],
    }).caseMaterials).toEqual([{ title: "案例", summary: "摘要", assetUrl: "https://cdn.example.com/case.png" }]);
    expect(() => parseMarketingProduct({
      name: "会员版", caseMaterials: [{ title: "案例", summary: "摘要", assetUrl: "javascript:alert(1)" }],
    })).toThrow("素材链接只支持HTTP(S)或站内路径");
    expect(() => parseMarketingProduct({
      name: "会员版", caseMaterials: [{ title: "案例", summary: "摘要", assetUrl: "ftp://example.com/case.png" }],
    })).toThrow(InputError);
    expect(() => parseMarketingBrandAssets({
      visualAssets: [{ name: "logo", url: "ftp://example.com/logo.png" }],
    })).toThrow("视觉资产链接只支持HTTP(S)或站内路径");
    expect(parseMarketingBrandAssets({
      visualAssets: [{ name: "logo", url: "/static/assets/logo.png", type: "图片" }],
    }).visualAssets).toEqual([{ name: "logo", url: "/static/assets/logo.png", type: "图片" }]);
  });
});

describe("parseMarketingProductUpdate", () => {
  it("要求合法version且至少一个可更新字段", () => {
    expect(() => parseMarketingProductUpdate({ positioning: "新定位" })).toThrow("version无效");
    expect(() => parseMarketingProductUpdate({ positioning: "新定位", version: 0 })).toThrow("version无效");
    expect(() => parseMarketingProductUpdate({ version: 2 })).toThrow("没有可更新的产品字段");
  });

  it("部分更新只保留显式提供的字段", () => {
    const result = parseMarketingProductUpdate({ version: 3, positioning: "新定位", coreValues: ["省心"] });
    expect(result).toEqual({ version: 3, positioning: "新定位", coreValues: ["省心"] });
    expect("name" in result).toBe(false);
  });
});

describe("parseMarketingBrandAssets", () => {
  it("version可选但必须合法", () => {
    expect(parseMarketingBrandAssets({ tone: ["专业"] }).version).toBeUndefined();
    expect(parseMarketingBrandAssets({ tone: ["专业"], version: 4 }).version).toBe(4);
    expect(() => parseMarketingBrandAssets({ tone: ["专业"], version: 0 })).toThrow("version无效");
  });

  it("拒绝没有任何品牌字段的请求", () => {
    expect(() => parseMarketingBrandAssets({})).toThrow("没有可更新的品牌字段");
    expect(() => parseMarketingBrandAssets({ version: 2 })).toThrow("没有可更新的品牌字段");
  });
});

describe("parseMarketingProductList", () => {
  it("提供默认分页并裁剪搜索词", () => {
    expect(parseMarketingProductList({})).toEqual({ page: 1, limit: 20 });
    expect(parseMarketingProductList({ q: "  会员  ", page: "2", limit: "50", status: "archived" }))
      .toEqual({ page: 2, limit: 50, query: "会员", status: "archived" });
    expect(parseMarketingProductList({ q: `  ${"会".repeat(250)}  ` }).query).toHaveLength(200);
  });

  it("拒绝越界分页与未知状态", () => {
    expect(() => parseMarketingProductList({ page: "0" })).toThrow("page无效");
    expect(() => parseMarketingProductList({ limit: "101" })).toThrow("limit无效");
    expect(() => parseMarketingProductList({ status: "banned" })).toThrow("status无效");
  });
});

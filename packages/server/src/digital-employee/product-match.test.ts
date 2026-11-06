import { describe, expect, it } from "vitest";
import { confidentProductMatch, productMatchScore, resolveProductMention, resolveTalkTrackProducts } from "./product-match.js";

const gateway = { id: "p1", name: "API 网关" };
const ops = { id: "p2", name: "机房运维服务" };
const mini = { id: "p3", name: "微信小程序开发" };
const catalog = [gateway, ops, mini];

describe("product matching", () => {
  it.each([
    ["API网关", 100],
    ["api 网关", 100],
    ["ＡＰＩ网关", 100],
    ["我们的 API 网关怎么收费", 90],
    ["机房运维怎么样", 80],
  ])("recognises %s", (mention, score) => {
    expect(productMatchScore(mention, score === 80 ? ops.name : gateway.name)).toBe(score);
  });

  it("accepts part of a name, a typo and a loose word, each scoring lower", () => {
    expect(productMatchScore("网关", gateway.name)).toBe(70);
    expect(productMatchScore("API网管", gateway.name)).toBe(60);
    expect(productMatchScore("那个网关多少钱", gateway.name)).toBe(50);
  });

  it("does not match unrelated text or generic words", () => {
    expect(resolveProductMention("明天回访一下", catalog).matches).toEqual([]);
    expect(productMatchScore("服务", "云平台服务")).toBe(70);
    expect(productMatchScore("这个服务不错", "云平台服务")).toBe(0);
  });

  it("only treats a single strong match as confident", () => {
    expect(confidentProductMatch("API网关", catalog)).toBe(gateway);
    expect(confidentProductMatch("网关", [gateway, { id: "p4", name: "AI 网关" }])).toBeNull();
    expect(confidentProductMatch("那个网关多少钱", catalog)).toBeNull();
    expect(confidentProductMatch("机房运维", catalog)).toBe(ops);
    expect(confidentProductMatch("API网关增强版", catalog)).toBeNull();
  });
});

describe("talk-track product resolution", () => {
  it("prefers the product named in the request over the one on file", () => {
    const result = resolveTalkTrackProducts({ texts: ["这次聊聊机房运维"], named: ["API 网关"] }, catalog);
    expect(result).toEqual({ products: [ops], uncertain: false });
  });

  it("keeps every product the request names", () => {
    const result = resolveTalkTrackProducts({ texts: ["对比 API 网关和机房运维服务"], named: [] }, catalog);
    expect(result.products).toEqual([gateway, ops]);
    expect(result.uncertain).toBe(false);
  });

  it("does not let a stray word override the product on file", () => {
    const result = resolveTalkTrackProducts({ texts: ["生成一条微信消息"], named: ["API 网关"] }, catalog);
    expect(result).toEqual({ products: [gateway], uncertain: false });
  });

  it("falls back to earlier requests and marks loose guesses", () => {
    expect(resolveTalkTrackProducts({ texts: ["再短一点", "写 API 网关的话术"], named: [] }, catalog).products).toEqual([gateway]);
    expect(resolveTalkTrackProducts({ texts: ["那个网关多少钱"], named: [] }, catalog)).toEqual({ products: [gateway], uncertain: true });
  });

  it("marks a tie as uncertain instead of picking one", () => {
    const twins = [gateway, { id: "p4", name: "AI 网关" }];
    expect(resolveTalkTrackProducts({ texts: ["写跟进"], named: ["网关"] }, twins)).toEqual({ products: twins, uncertain: true });
  });

  it("uses a shop's only product when nothing names one, but never overrides a different name", () => {
    expect(resolveTalkTrackProducts({ texts: ["写跟进"], named: [] }, [gateway])).toEqual({ products: [gateway], uncertain: false });
    expect(resolveTalkTrackProducts({ texts: ["写跟进"], named: ["边缘算力"] }, [gateway]).products).toEqual([]);
  });
});

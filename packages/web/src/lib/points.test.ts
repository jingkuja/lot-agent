import { describe, expect, it } from "vitest";
import { isValidRechargePoints, pointsToYuan, rechargeDiscountForPoints, rechargeDiscountTiers, rechargePayableYuan, yuanToPoints } from "./points.js";

describe("points display conversion", () => {
  it("maps 100 points to one yuan", () => {
    expect(pointsToYuan(100)).toBe(1);
    expect(yuanToPoints(1)).toBe(100);
  });

  it("rounds monetary storage values to whole display points", () => {
    expect(yuanToPoints(12.345)).toBe(1235);
  });

  it("accepts recharge values in 100-point increments", () => {
    expect(isValidRechargePoints(100)).toBe(true);
    expect(isValidRechargePoints(1_500)).toBe(true);
    expect(isValidRechargePoints(150)).toBe(false);
    expect(isValidRechargePoints(0)).toBe(false);
  });
});

describe("recharge discounts", () => {
  const tiers = { "1000": 0.95, "5000": 0.9, "10000": 0.8 };

  it("matches the largest threshold not exceeding the recharge points", () => {
    expect(rechargeDiscountForPoints(999, tiers)).toBe(1);
    expect(rechargeDiscountForPoints(1_000, tiers)).toBe(0.95);
    expect(rechargeDiscountForPoints(9_999, tiers)).toBe(0.9);
    expect(rechargeDiscountForPoints(10_000, tiers)).toBe(0.8);
  });

  it("rounds the discounted amount to the same cent boundary as New API", () => {
    expect(rechargePayableYuan(1_000, tiers)).toBe(9.5);
    expect(rechargePayableYuan(5_000, tiers)).toBe(45);
  });

  it("returns sorted valid tiers for display", () => {
    expect(rechargeDiscountTiers({ "5000": 0.9, invalid: 0.5, "1000": 0.95, "10000": 2 })).toEqual([
      { threshold: 1_000, discount: 0.95 },
      { threshold: 5_000, discount: 0.9 },
    ]);
  });
});

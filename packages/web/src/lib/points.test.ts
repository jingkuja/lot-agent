import { describe, expect, it } from "vitest";
import { isValidRechargePoints, pointsToYuan, yuanToPoints } from "./points.js";

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

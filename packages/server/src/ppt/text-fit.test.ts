import { expect, it } from "vitest";
import { fitText } from "./text-fit.js";

it("fits explicit line breaks and CJK text before export while retaining a readable floor", () => {
  const short = fitText("简洁结论", { w: 5, h: 1, fontSize: 28 });
  const crowded = fitText("这是需要适应盒子宽度的中文内容".repeat(3), { w: 3, h: 1, fontSize: 28 });
  expect(short.fontSize).toBe(28);
  expect(crowded.fontSize).toBeLessThan(28);
  expect(crowded.fontSize).toBeGreaterThanOrEqual(12);
  expect(fitText("a\nb\nc", { w: 4, h: 0.7, fontSize: 28 }).fontSize).toBeLessThan(28);
});

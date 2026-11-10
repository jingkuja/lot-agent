import { describe, expect, it } from "vitest";
import { productPromptText, withProductText } from "./product-reference.js";

describe("product reference text", () => {
  it("uses the name, positioning and up to three selling points", () => {
    expect(productPromptText({ name: " 保温杯 ", positioning: "通勤用", coreValues: ["12 小时保温", "316 不锈钢", " ", "轻", "防漏"] }))
      .toBe("保温杯，通勤用；卖点：12 小时保温、316 不锈钢、轻");
    expect(productPromptText({ name: "保温杯", positioning: "", coreValues: [] })).toBe("保温杯");
  });

  it("puts the product first, keeps what was typed, and never adds it twice", () => {
    expect(withProductText("", "保温杯")).toBe("保温杯");
    expect(withProductText("放在海边", "保温杯")).toBe("保温杯\n放在海边");
    expect(withProductText("保温杯\n放在海边", "保温杯")).toBe("保温杯\n放在海边");
  });
});

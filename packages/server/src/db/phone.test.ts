import { describe, expect, it } from "vitest";
import { maskPhone } from "./phone.js";

describe("maskPhone", () => {
  it("keeps the first three and last four digits", () => {
    expect(maskPhone("13800138000")).toBe("138****8000");
  });

  it("does not expose an empty phone", () => {
    expect(maskPhone(" ")).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
  });
});

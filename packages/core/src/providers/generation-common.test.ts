import { describe, it, expect } from "vitest";
import { parseSize } from "./generation-common.js";

describe("parseSize", () => {
  it("parses WxH", () => {
    expect(parseSize("1024x768")).toEqual([1024, 768]);
  });
  it("parses W*H (chat-completions size format)", () => {
    expect(parseSize("2688*1536")).toEqual([2688, 1536]);
  });
  it("defaults to 1024x1024 for missing / malformed", () => {
    expect(parseSize(undefined)).toEqual([1024, 1024]);
    expect(parseSize("huge")).toEqual([1024, 1024]);
  });
});

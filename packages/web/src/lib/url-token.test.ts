import { describe, it, expect } from "vitest";
import { readTokenFromUrl } from "./url-token.js";

describe("readTokenFromUrl", () => {
  it("extracts the token param", () => {
    expect(readTokenFromUrl("?token=jwt.abc.def")).toBe("jwt.abc.def");
  });

  it("decodes percent-encoded values", () => {
    expect(readTokenFromUrl("?token=a%2Bb%2Fc%3D")).toBe("a+b/c=");
  });

  it("works alongside other params", () => {
    expect(readTokenFromUrl("?foo=1&token=xyz&bar=2")).toBe("xyz");
  });

  it("returns null when absent", () => {
    expect(readTokenFromUrl("")).toBeNull();
    expect(readTokenFromUrl("?foo=1")).toBeNull();
  });

  it("returns null when blank", () => {
    expect(readTokenFromUrl("?token=")).toBeNull();
    expect(readTokenFromUrl("?token=%20%20")).toBeNull();
  });
});

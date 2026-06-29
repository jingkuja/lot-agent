import { afterEach, describe, expect, it } from "vitest";
import { staticPrefix } from "./public-base.js";

const ORIGINAL = process.env.PUBLIC_BASE_URL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = ORIGINAL;
});

describe("staticPrefix", () => {
  it("returns the host-relative path when PUBLIC_BASE_URL is unset", () => {
    delete process.env.PUBLIC_BASE_URL;
    expect(staticPrefix("/static/documents")).toBe("/static/documents");
  });

  it("prepends an absolute base when set", () => {
    process.env.PUBLIC_BASE_URL = "http://192.168.1.50:3000";
    expect(staticPrefix("/static/documents")).toBe("http://192.168.1.50:3000/static/documents");
  });

  it("trims trailing slashes so it never produces a double slash", () => {
    process.env.PUBLIC_BASE_URL = "http://192.168.1.50:3000/";
    expect(staticPrefix("/static/assets")).toBe("http://192.168.1.50:3000/static/assets");
  });
});

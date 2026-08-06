import { afterEach, describe, expect, it } from "vitest";
import { publicStaticUrl, staticPrefix } from "./public-base.js";

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

  it("makes locally-served static resources public without changing external URLs", () => {
    process.env.PUBLIC_BASE_URL = "https://box.example.com/";
    expect(publicStaticUrl("/static/uploads/frame.png")).toBe("https://box.example.com/static/uploads/frame.png");
    expect(publicStaticUrl("https://vendor.example.com/video.mp4")).toBe("https://vendor.example.com/video.mp4");
    expect(publicStaticUrl("data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
  });
});

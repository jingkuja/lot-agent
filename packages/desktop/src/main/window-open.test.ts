import { describe, expect, it } from "vitest";
import { classifyWindowOpen } from "./window-open.js";

describe("classifyWindowOpen", () => {
  const origin = "http://127.0.0.1:41234";

  it("routes same-origin static and comic-drama media links to controlled download", () => {
    expect(classifyWindowOpen(`${origin}/static/assets/img.png`, origin)).toBe("download");
    expect(classifyWindowOpen(`${origin}/api/public/comic-drama-media/abc.png?material_token=tok`, origin)).toBe("download");
  });

  it("denies other same-origin loopback URLs and non-http(s) schemes", () => {
    expect(classifyWindowOpen(`${origin}/comic-drama`, origin)).toBe("deny");
    expect(classifyWindowOpen("about:blank", origin)).toBe("deny");
    expect(classifyWindowOpen("javascript:alert(1)", origin)).toBe("deny");
    expect(classifyWindowOpen("file:///etc/passwd", origin)).toBe("deny");
    expect(classifyWindowOpen("not a url", origin)).toBe("deny");
  });

  it("allows external https/http URLs to open in the system browser", () => {
    expect(classifyWindowOpen("https://example.com/docs", origin)).toBe("external");
    expect(classifyWindowOpen("http://example.com/page", origin)).toBe("external");
  });
});

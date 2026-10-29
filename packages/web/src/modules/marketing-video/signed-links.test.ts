import { describe, expect, it } from "vitest";
import { keepLink, linkPath, SIGNED_LINK_REUSE_MS } from "./signed-links.js";

describe("signed video links", () => {
  const first = "/api/outputs/a.mp4?material_token=one";
  it("keeps the first link to a file while it is fresh, so a saved draft does not reload the player", () => {
    const kept = keepLink(undefined, first, 0);
    expect(keepLink(kept, "/api/outputs/a.mp4?material_token=two", SIGNED_LINK_REUSE_MS - 1)).toBe(kept);
  });
  it("takes the new link for another file or once the kept one is old", () => {
    const kept = keepLink(undefined, first, 0);
    expect(keepLink(kept, "/api/outputs/b.mp4?material_token=two", 1).url).toBe("/api/outputs/b.mp4?material_token=two");
    expect(keepLink(kept, "/api/outputs/a.mp4?material_token=two", SIGNED_LINK_REUSE_MS).url).toBe("/api/outputs/a.mp4?material_token=two");
  });
  it("compares files without their signature", () => {
    expect(linkPath(first)).toBe("/api/outputs/a.mp4");
    expect(linkPath("/static/fixture.mp4")).toBe("/static/fixture.mp4");
  });
});

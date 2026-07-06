import { describe, it, expect } from "vitest";
import { KeywordReviewProvider } from "./review.js";

describe("KeywordReviewProvider", () => {
  it("rejects text containing a default banned word", async () => {
    const provider = new KeywordReviewProvider();
    const result = await provider.reviewText("this is spam-test-word here");
    expect(result.verdict).toBe("reject");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("passes clean text", async () => {
    const provider = new KeywordReviewProvider();
    const result = await provider.reviewText("this is totally clean content");
    expect(result.verdict).toBe("pass");
    expect(result.reasons).toHaveLength(0);
  });

  it("is case-insensitive with custom banned list", async () => {
    const provider = new KeywordReviewProvider(["foo"]);
    const result = await provider.reviewText("a FOO b");
    expect(result.verdict).toBe("reject");
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe("KeywordReviewProvider.review (multimodal)", () => {
  it("rejects banned text via the unified review() entrypoint", async () => {
    const provider = new KeywordReviewProvider();
    const r = await provider.review({ kind: "text", text: "contains spam-test-word ok" });
    expect(r.verdict).toBe("reject");
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("passes clean text via review()", async () => {
    const provider = new KeywordReviewProvider();
    const r = await provider.review({ kind: "text", text: "all clean here" });
    expect(r.verdict).toBe("pass");
  });

  it("returns 'suspect' for image — the keyword stub can't inspect pixels", async () => {
    const provider = new KeywordReviewProvider();
    const r = await provider.review({ kind: "image", url: "https://x/a.png" });
    expect(r.verdict).toBe("suspect");
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("returns 'suspect' for video", async () => {
    const provider = new KeywordReviewProvider();
    const r = await provider.review({ kind: "video", url: "https://x/a.mp4", scene: "publish" });
    expect(r.verdict).toBe("suspect");
  });

  it("reviewText remains a working compat shell over review()", async () => {
    const provider = new KeywordReviewProvider();
    const r = await provider.reviewText("spam-test-word");
    expect(r.verdict).toBe("reject");
  });
});

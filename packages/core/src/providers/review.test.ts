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

export type ReviewVerdict = "pass" | "suspect" | "reject";

/** What is being reviewed. Publish-scene review is expected to be stricter. */
export interface ReviewInput {
  kind: "text" | "image" | "video";
  text?: string;
  url?: string; // image/video artifact address
  scene?: "chat" | "publish";
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  reasons: string[];
  /** Violation categories (政治/色情/广告法…) — optional, filled when known. */
  labels?: string[];
}

export interface ReviewProvider {
  review(input: ReviewInput): Promise<ReviewResult>;
  /** @deprecated use {@link review} with `{ kind: "text" }`. Kept for callers not yet migrated. */
  reviewText(text: string): Promise<ReviewResult>;
}

/** Local banned-keyword filter — first-line stub before any cloud review. */
export class KeywordReviewProvider implements ReviewProvider {
  private readonly banned: string[];
  constructor(bannedWords: string[] = ["违禁", "反动", "blood", "spam-test-word"]) {
    this.banned = bannedWords.map((w) => w.toLowerCase());
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    if (input.kind === "text") {
      const lower = (input.text ?? "").toLowerCase();
      const hits = this.banned.filter((w) => lower.includes(w));
      if (hits.length > 0) {
        return {
          verdict: "reject",
          reasons: hits.map((w) => `banned keyword: ${w}`),
          labels: ["banned-keyword"],
        };
      }
      return { verdict: "pass", reasons: [] };
    }
    // The keyword stub can't inspect pixels/frames. Return `suspect` (not `pass`)
    // so the publish chain must make an explicit decision on non-text artifacts
    // instead of silently letting them through.
    return {
      verdict: "suspect",
      reasons: [`keyword stub cannot review ${input.kind} content`],
    };
  }

  /** @deprecated compat shell over {@link review}. */
  async reviewText(text: string): Promise<ReviewResult> {
    return this.review({ kind: "text", text });
  }
}

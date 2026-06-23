export type ReviewVerdict = "pass" | "suspect" | "reject";
export interface ReviewResult { verdict: ReviewVerdict; reasons: string[]; }
export interface ReviewProvider {
  reviewText(text: string): Promise<ReviewResult>;
}

/** Local banned-keyword filter — first-line stub before any cloud review. */
export class KeywordReviewProvider implements ReviewProvider {
  private readonly banned: string[];
  constructor(bannedWords: string[] = ["违禁", "反动", "blood", "spam-test-word"]) {
    this.banned = bannedWords.map((w) => w.toLowerCase());
  }
  async reviewText(text: string): Promise<ReviewResult> {
    const lower = text.toLowerCase();
    const hits = this.banned.filter((w) => lower.includes(w));
    if (hits.length > 0) return { verdict: "reject", reasons: hits.map((w) => `banned keyword: ${w}`) };
    return { verdict: "pass", reasons: [] };
  }
}

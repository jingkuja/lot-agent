import { describe, expect, it } from "vitest";
import { marketingProductFaqNotes } from "./0021-marketing-product-faq-notes.js";

describe("marketing-product-faq-notes migration", () => {
  it("adds faqs and product_notes columns", async () => {
    const statements: string[] = [];
    await marketingProductFaqNotes.up({
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [] };
      },
    } as any);
    expect(marketingProductFaqNotes.version).toBe(21);
    expect(statements.join("\n")).toContain("ADD COLUMN IF NOT EXISTS faqs");
    expect(statements.join("\n")).toContain("ADD COLUMN IF NOT EXISTS product_notes");
  });
});

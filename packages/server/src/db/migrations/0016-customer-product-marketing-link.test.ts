import { describe, expect, it, vi } from "vitest";
import { customerProductMarketingLink } from "./0016-customer-product-marketing-link.js";
import { migrations } from "./index.js";

describe("customer product marketing link migration", () => {
  it("adds and backfills marketing product references", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await customerProductMarketingLink.up({ query } as any);

    const ddl = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(ddl).toContain("marketing_product_id UUID");
    expect(ddl).toContain("FROM marketing_products product");
    expect(ddl).toContain("product.user_id = state.user_id");
    expect(customerProductMarketingLink.version).toBe(16);
    expect(migrations.find((migration) => migration.version === 16)).toBe(customerProductMarketingLink);
  });
});

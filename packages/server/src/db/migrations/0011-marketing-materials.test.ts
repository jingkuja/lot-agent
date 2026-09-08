import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "../migration-runner.js";
import { migrations } from "./index.js";
import { marketingMaterials } from "./0011-marketing-materials.js";

describe("marketing materials migration", () => {
  it("registers the product and brand fact tables", async () => {
    const statements: string[] = [];
    const client = { query: vi.fn(async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    }) } as QueryClient;

    await marketingMaterials.up(client);
    const ddl = statements.join("\n");
    expect(marketingMaterials.version).toBe(11);
    expect(migrations.find((migration) => migration.version === 11)).toBe(marketingMaterials);
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS marketing_products");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS marketing_brand_assets");
    expect(ddl).toContain("current_benefits");
    expect(ddl).toContain("case_materials");
    expect(ddl).toContain("standard_calls_to_action");
    expect(ddl).toContain("uq_marketing_products_user_active_name");
  });
});

import type { Pool } from "pg";
import type { QueryClient } from "../db/migration-runner.js";
import type {
  MarketingBrandAssets,
  MarketingBrandAssetsInput,
  MarketingProduct,
  MarketingProductInput,
  MarketingProductListFilters,
  MarketingProductListResult,
  MarketingProductUpdateInput,
} from "./marketing-types.js";

export class MarketingMaterialsRepository {
  constructor(private readonly pool: Pool) {}

  async listProducts(userId: string, filters: MarketingProductListFilters): Promise<MarketingProductListResult> {
    const params: unknown[] = [userId, filters.status ?? "active"];
    const where = ["user_id = $1", "status = $2"];
    if (filters.query) {
      params.push(`%${filters.query}%`);
      where.push(`(name ILIKE $${params.length} OR positioning ILIKE $${params.length})`);
    }
    const whereSql = where.join(" AND ");
    const count = await this.pool.query(`SELECT count(*)::int AS total FROM marketing_products WHERE ${whereSql}`, params);
    params.push(filters.limit, (filters.page - 1) * filters.limit);
    const result = await this.pool.query(
      `SELECT * FROM marketing_products WHERE ${whereSql}
       ORDER BY updated_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return {
      items: result.rows.map(toProduct),
      page: filters.page,
      limit: filters.limit,
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  async getProduct(userId: string, id: string): Promise<MarketingProduct | null> {
    const result = await this.pool.query("SELECT * FROM marketing_products WHERE user_id = $1 AND id = $2", [userId, id]);
    return result.rows[0] ? toProduct(result.rows[0]) : null;
  }

  async findActiveProductByName(userId: string, name: string): Promise<MarketingProduct | null> {
    const result = await this.pool.query(
      "SELECT * FROM marketing_products WHERE user_id = $1 AND status = 'active' AND lower(name) = lower($2) LIMIT 1",
      [userId, name]
    );
    return result.rows[0] ? toProduct(result.rows[0]) : null;
  }

  async findActiveProductsMentionedInText(userId: string, text: string): Promise<MarketingProduct[]> {
    const result = await this.pool.query(
      `SELECT * FROM marketing_products
       WHERE user_id = $1 AND status = 'active' AND char_length(trim(name)) >= 2
         AND position(lower(name) in lower($2)) > 0
       ORDER BY char_length(name) DESC, updated_at DESC
       LIMIT 5`,
      [userId, text]
    );
    return result.rows.map(toProduct);
  }

  async createProduct(userId: string, id: string, input: MarketingProductInput, client: QueryClient = this.pool): Promise<MarketingProduct> {
    const result = await client.query(
      `INSERT INTO marketing_products (
         id, user_id, name, positioning, core_values, verifiable_facts, common_objections,
         current_benefits, prohibited_expressions, case_materials
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10::jsonb)
       RETURNING *`,
      [
        id, userId, input.name, input.positioning ?? "", input.coreValues ?? [],
        JSON.stringify(input.verifiableFacts ?? []), JSON.stringify(input.commonObjections ?? []),
        JSON.stringify(input.currentBenefits ?? []), input.prohibitedExpressions ?? [],
        JSON.stringify(input.caseMaterials ?? []),
      ]
    );
    return toProduct(result.rows[0]);
  }

  async updateProduct(userId: string, id: string, input: MarketingProductUpdateInput): Promise<MarketingProduct | null> {
    const result = await this.pool.query(
      `UPDATE marketing_products SET
         name = COALESCE($4, name), positioning = COALESCE($5, positioning),
         core_values = COALESCE($6, core_values), verifiable_facts = COALESCE($7::jsonb, verifiable_facts),
         common_objections = COALESCE($8::jsonb, common_objections), current_benefits = COALESCE($9::jsonb, current_benefits),
         prohibited_expressions = COALESCE($10, prohibited_expressions), case_materials = COALESCE($11::jsonb, case_materials),
         version = version + 1
       WHERE user_id = $1 AND id = $2 AND version = $3 AND status = 'active'
       RETURNING *`,
      [
        userId, id, input.version, input.name ?? null, input.positioning ?? null, input.coreValues ?? null,
        input.verifiableFacts === undefined ? null : JSON.stringify(input.verifiableFacts),
        input.commonObjections === undefined ? null : JSON.stringify(input.commonObjections),
        input.currentBenefits === undefined ? null : JSON.stringify(input.currentBenefits),
        input.prohibitedExpressions ?? null,
        input.caseMaterials === undefined ? null : JSON.stringify(input.caseMaterials),
      ]
    );
    return result.rows[0] ? toProduct(result.rows[0]) : null;
  }

  async archiveProduct(userId: string, id: string, version: number): Promise<MarketingProduct | null> {
    const result = await this.pool.query(
      `UPDATE marketing_products SET status = 'archived', archived_at = now(), version = version + 1
       WHERE user_id = $1 AND id = $2 AND version = $3 AND status = 'active' RETURNING *`,
      [userId, id, version]
    );
    return result.rows[0] ? toProduct(result.rows[0]) : null;
  }

  async getBrandAssets(userId: string): Promise<MarketingBrandAssets | null> {
    const result = await this.pool.query("SELECT * FROM marketing_brand_assets WHERE user_id = $1", [userId]);
    return result.rows[0] ? toBrandAssets(result.rows[0]) : null;
  }

  async createBrandAssets(userId: string, id: string, input: MarketingBrandAssetsInput): Promise<MarketingBrandAssets> {
    const result = await this.pool.query(
      `INSERT INTO marketing_brand_assets (id, user_id, tone, visual_assets, standard_calls_to_action)
       VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *`,
      [id, userId, input.tone ?? [], JSON.stringify(input.visualAssets ?? []), input.standardCallsToAction ?? []]
    );
    return toBrandAssets(result.rows[0]);
  }

  async updateBrandAssets(userId: string, input: MarketingBrandAssetsInput & { version: number }): Promise<MarketingBrandAssets | null> {
    const result = await this.pool.query(
      `UPDATE marketing_brand_assets SET
         tone = COALESCE($3, tone), visual_assets = COALESCE($4::jsonb, visual_assets),
         standard_calls_to_action = COALESCE($5, standard_calls_to_action), version = version + 1
       WHERE user_id = $1 AND version = $2 RETURNING *`,
      [
        userId, input.version, input.tone ?? null,
        input.visualAssets === undefined ? null : JSON.stringify(input.visualAssets),
        input.standardCallsToAction ?? null,
      ]
    );
    return result.rows[0] ? toBrandAssets(result.rows[0]) : null;
  }
}

function toProduct(row: any): MarketingProduct {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    positioning: row.positioning ?? "",
    coreValues: row.core_values ?? [],
    verifiableFacts: row.verifiable_facts ?? [],
    commonObjections: row.common_objections ?? [],
    currentBenefits: row.current_benefits ?? [],
    prohibitedExpressions: row.prohibited_expressions ?? [],
    caseMaterials: row.case_materials ?? [],
    status: row.status,
    version: Number(row.version),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toBrandAssets(row: any): MarketingBrandAssets {
  return {
    id: row.id,
    userId: row.user_id,
    tone: row.tone ?? [],
    visualAssets: row.visual_assets ?? [],
    standardCallsToAction: row.standard_calls_to_action ?? [],
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

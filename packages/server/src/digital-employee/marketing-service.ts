import { randomUUID } from "node:crypto";
import type { DB } from "../db/database.js";
import { ConflictError, InputError, NotFoundError } from "./errors.js";
import { MarketingMaterialsRepository } from "./marketing-repository.js";
import type {
  MarketingBrandAssetsInput,
  MarketingProductInput,
  MarketingProductListFilters,
  MarketingProductUpdateInput,
} from "./marketing-types.js";

export class MarketingMaterialsService {
  readonly repository: MarketingMaterialsRepository;

  constructor(db: DB) {
    this.repository = new MarketingMaterialsRepository(db.pool);
  }

  listProducts(userId: string, filters: MarketingProductListFilters) {
    return this.repository.listProducts(userId, filters);
  }

  async getProduct(userId: string, id: string) {
    const product = await this.repository.getProduct(userId, id);
    if (!product) throw new NotFoundError("未找到该产品资料");
    return product;
  }

  async createProduct(userId: string, input: MarketingProductInput) {
    try {
      return await this.repository.createProduct(userId, randomUUID(), input);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError("已有同名的有效产品资料");
      throw error;
    }
  }

  async updateProduct(userId: string, id: string, input: MarketingProductUpdateInput) {
    try {
      const product = await this.repository.updateProduct(userId, id, input);
      if (product) return product;
      const existing = await this.repository.getProduct(userId, id);
      if (!existing) throw new NotFoundError("未找到该产品资料");
      if (existing.status === "archived") throw new InputError("已归档的产品不能修改");
      throw new ConflictError();
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError("已有同名的有效产品资料");
      throw error;
    }
  }

  async archiveProduct(userId: string, id: string, version: number) {
    const product = await this.repository.archiveProduct(userId, id, version);
    if (product) return product;
    const existing = await this.repository.getProduct(userId, id);
    if (!existing) throw new NotFoundError("未找到该产品资料");
    throw new ConflictError();
  }

  getBrandAssets(userId: string) {
    return this.repository.getBrandAssets(userId);
  }

  async saveBrandAssets(userId: string, input: MarketingBrandAssetsInput) {
    const existing = await this.repository.getBrandAssets(userId);
    if (!existing) {
      try {
        return await this.repository.createBrandAssets(userId, randomUUID(), input);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw new ConflictError();
      }
    }
    if (input.version === undefined) throw new ConflictError("品牌资料已存在，请刷新后再保存");
    const updated = await this.repository.updateBrandAssets(userId, { ...input, version: input.version });
    if (!updated) throw new ConflictError();
    return updated;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

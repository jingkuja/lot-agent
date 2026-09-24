import { z } from "zod";
export const KnowledgeKeyInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  collectionIds: z.array(z.string().uuid()).min(1).max(10).refine((ids) => new Set(ids).size === ids.length),
  scopes: z.array(z.enum(["retrieval:read", "profile:read", "assets:read"])).min(1).max(3).refine((ids) => new Set(ids).size === ids.length).default(["retrieval:read"]),
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
}).strict();
export const KnowledgeKeyUpdateSchema = KnowledgeKeyInputSchema.extend({ version: z.number().int().positive() });
export const KnowledgeProfileRequestSchema = z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/)).min(1).max(50);

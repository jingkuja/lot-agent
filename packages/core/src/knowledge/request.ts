import { z } from "zod";
import type { KnowledgeRetrievalRequest } from "./types.js";

const id = z.string().min(1).max(200).refine((value) => value.trim() === value);
export const KnowledgeCollectionIdsSchema = z.array(id).min(1).max(10)
  .refine((ids) => new Set(ids).size === ids.length, "Collection IDs must be unique");

const schema = z.object({
  query: z.string().trim().min(1).refine((value) => Array.from(value).length <= 2000),
  collection_ids: KnowledgeCollectionIdsSchema,
  top_k: z.number().int().min(1).max(20).default(5),
  mode: z.enum(["keyword", "semantic", "hybrid"]).default("hybrid"),
  allow_degraded: z.boolean().default(false),
  filters: z.object({
    source_types: z.array(z.enum(["document", "note", "bookmark", "image", "audio", "video", "profile_fact"]))
      .min(1).max(7).default(["document", "note"]),
    tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  }).strict().default({}),
}).strict();

/** Wire input is a whitelist. In particular it cannot carry owner, key grants or internal object keys. */
export function parseKnowledgeRetrievalRequest(input: unknown): KnowledgeRetrievalRequest {
  const value = schema.parse(input);
  return {
    query: value.query, collectionIds: value.collection_ids, topK: value.top_k,
    mode: value.mode, allowDegraded: value.allow_degraded,
    sourceTypes: value.filters.source_types, tags: value.filters.tags,
  };
}

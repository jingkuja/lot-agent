import { z } from "zod";
const uuid = z.string().uuid();
const ids = z.array(uuid).max(10).refine((value) => new Set(value).size === value.length).default([]);
const tags = z.array(z.string().trim().min(1).max(100)).max(20).refine((value) => new Set(value).size === value.length).default([]);
const description = z.string().max(5000).default("");
const title = z.string().trim().min(1).max(255).refine((value) => !/[\x00-\x1f\x7f/\\]/.test(value));
export const KnowledgeCollectionInputSchema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(2000).default("") }).strict();
export const KnowledgeCollectionUpdateSchema = KnowledgeCollectionInputSchema.extend({ version: z.number().int().positive() });
export const KnowledgeItemInputSchema = z.object({
  title, sourceType: z.enum(["note", "bookmark"]), description,
  content: z.string().max(200_000).optional(),
  sourceUrl: z.string().max(2000).url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)).optional(),
  collectionIds: ids, tags,
}).strict().superRefine((value, context) => {
  if (value.sourceType === "note" && !value.content?.trim()) context.addIssue({ code: "custom", message: "笔记正文不能为空" });
  if (value.sourceType === "bookmark" && !value.sourceUrl) context.addIssue({ code: "custom", message: "书签地址不能为空" });
});
export const KnowledgeUploadMetadataSchema = z.object({ title, description, collectionIds: ids, tags }).strict();
export const KnowledgeDeleteSchema = z.object({ version: z.number().int().positive() }).strict();
export const KnowledgeUuidSchema = uuid;
export const KnowledgeItemUpdateSchema = z.object({
  version: z.number().int().positive(), title, description, tags,
  content: z.string().max(200_000).optional(),
  sourceUrl: z.string().max(2000).url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)).optional(),
}).strict();

import { z } from "zod";

export const KnowledgeConfigSchema = z.object({
  source: z.enum(["remote", "local"]).default("remote"),
}).strict().default({});
export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>;

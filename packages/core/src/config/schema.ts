import { z } from "zod";

const ModelConfigSchema = z.object({
  id: z.string(),
  type: z.enum(["llm", "image", "video", "tts", "asr", "embedding", "review"]),
  provider: z.string(),
  billingUnit: z.enum(["token", "image", "second", "character", "request"]),
  inputPrice: z.number(),
  outputPrice: z.number(),
  unitPrice: z.number(),
  enabled: z.boolean(),
});

export const AppConfigSchema = z.object({
  llm: z.object({
    default: z.enum(["openai", "anthropic"]),
    openai: z.object({
      apiKey: z.string(),
      baseUrl: z.string().optional(),
      model: z.string(),
    }),
    anthropic: z.object({
      apiKey: z.string(),
      model: z.string(),
    }),
  }),
  models: z.array(ModelConfigSchema).optional().default([]),
  agent: z.object({
    maxIterations: z.number(),
    systemPrompt: z.string(),
    context: z.object({}).passthrough().optional(),
  }),
  mcp: z.object({
    servers: z.array(z.unknown()),
  }),
  server: z.object({
    port: z.number(),
    host: z.string(),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

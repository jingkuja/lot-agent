import { z } from "zod";

const ModelCapabilitiesSchema = z.object({
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  vision: z.boolean().optional(),
  toolUse: z.boolean().optional(),
  reasoning: z.boolean().optional(),
});

const MCPServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: z.enum(["stdio", "sse", "streamable-http"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
});

const StorageSchema = z
  .object({
    driver: z.enum(["local", "s3"]).default("local"),
    s3: z
      .object({
        bucket: z.string(),
        region: z.string().optional(),
        endpoint: z.string().optional(),
        accessKeyId: z.string().optional(),
        secretAccessKey: z.string().optional(),
        publicBaseUrl: z.string().optional(),
        forcePathStyle: z.boolean().optional(),
      })
      .optional(),
  })
  .default({ driver: "local" });

const ModelConfigSchema = z.object({
  id: z.string(),
  type: z.enum(["llm", "image", "video", "tts", "asr", "embedding", "review"]),
  provider: z.string(),
  billingUnit: z.enum(["token", "image", "second", "character", "request"]),
  inputPrice: z.number(),
  outputPrice: z.number(),
  unitPrice: z.number(),
  enabled: z.boolean(),
  capabilities: ModelCapabilitiesSchema.optional(),
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
    servers: z.array(MCPServerSchema),
  }),
  storage: StorageSchema,
  server: z.object({
    port: z.number(),
    host: z.string(),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

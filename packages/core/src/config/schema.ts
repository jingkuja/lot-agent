import { z } from "zod";

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

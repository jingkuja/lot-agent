import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MockImageProvider,
  OpenAIImageProvider,
  MockVideoProvider,
  OpenAIVideoProvider,
  HttpGenerationProvider,
  MockGenerationProvider,
  pickAdapter,
  type ImageProvider,
  type VideoProvider,
  type GenerationProvider,
} from "@lot-agent/core";

export interface GenerationConfig {
  baseUrl: string;
  apiKey: string;
  mock: boolean;
  adapter: string;
  image: { model: string; modelId: string };
  video: { model: string; modelId: string };
}

/** Load the non-secret `generation` block from config + the key from env. */
export async function loadGenerationConfig(rootDir: string): Promise<GenerationConfig> {
  const raw = JSON.parse(await readFile(resolve(rootDir, "config/default.json"), "utf-8")) as {
    generation?: Partial<GenerationConfig>;
  };
  const g = raw.generation ?? {};
  return {
    baseUrl: g.baseUrl ?? "https://tokenhub.todoucloud.com/v1",
    apiKey: process.env.TOKENHUB_API_KEY ?? "",
    mock: g.mock ?? true,
    adapter: g.adapter ?? "happyhorse",
    image: { model: g.image?.model ?? "", modelId: g.image?.modelId ?? "wanx-standard" },
    video: { model: g.video?.model ?? "", modelId: g.video?.modelId ?? "kling-standard" },
  };
}

const useMock = (cfg: GenerationConfig) => cfg.mock || !cfg.apiKey;

export function makeImageProvider(cfg: GenerationConfig): ImageProvider {
  return useMock(cfg)
    ? new MockImageProvider()
    : new OpenAIImageProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.image.model });
}

export function makeVideoProvider(cfg: GenerationConfig): VideoProvider {
  return useMock(cfg)
    ? new MockVideoProvider()
    : new OpenAIVideoProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.video.model });
}

export function makeGenerationProvider(cfg: GenerationConfig): GenerationProvider {
  if (cfg.mock || !cfg.apiKey) return new MockGenerationProvider();
  return new HttpGenerationProvider({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    adapter: pickAdapter(cfg.adapter),
    imageModel: cfg.image.model,
    videoModel: cfg.video.model,
  });
}

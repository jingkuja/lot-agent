import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  HttpImageGenerationProvider,
  MockImageGenerationProvider,
  pickImageAdapter,
  HttpVideoGenerationProvider,
  MockVideoGenerationProvider,
  pickVideoAdapter,
  type ImageGenerationProvider,
  type VideoGenerationProvider,
} from "@lot-agent/core";

/** Fully-resolved settings for one media type's provider. Image and video are
 * independent so each carries its own endpoint/adapter/key — they can point at
 * different real vendors (通义万相 for image, 可灵 for video). */
export interface MediaGenerationConfig {
  baseUrl: string;
  apiKey: string;
  mock: boolean;
  adapter: string;
  model: string;
  modelId: string;
}

export interface GenerationConfig {
  image: MediaGenerationConfig;
  video: MediaGenerationConfig;
}

/** Raw per-media block as authored in config/default.json. Each field is an
 * optional override of the shared top-level default. */
interface RawMedia {
  model?: string;
  modelId?: string;
  baseUrl?: string;
  adapter?: string;
  mock?: boolean;
}
interface RawGeneration {
  baseUrl?: string;
  adapter?: string;
  mock?: boolean;
  image?: RawMedia;
  video?: RawMedia;
}

/**
 * Load the non-secret `generation` block from config + keys from env. Top-level
 * `baseUrl`/`adapter`/`mock` are shared defaults; each of `image`/`video` may
 * override any of them so the two providers can diverge onto different vendors.
 * Keys come from env: `IMAGE_GEN_API_KEY` / `VIDEO_GEN_API_KEY` override the
 * shared `TOKENHUB_API_KEY` when image and video use different vendors.
 */
export async function loadGenerationConfig(rootDir: string): Promise<GenerationConfig> {
  const raw = JSON.parse(await readFile(resolve(rootDir, "config/default.json"), "utf-8")) as {
    generation?: RawGeneration;
  };
  const g = raw.generation ?? {};
  const sharedBaseUrl = g.baseUrl ?? "https://tokenhub.todoucloud.com/v1";
  const sharedAdapter = g.adapter ?? "happyhorse";
  const sharedMock = g.mock ?? true;
  const sharedKey = process.env.TOKENHUB_API_KEY ?? "";

  const merge = (m: RawMedia | undefined, defaultModelId: string, keyEnv: string): MediaGenerationConfig => ({
    baseUrl: m?.baseUrl ?? sharedBaseUrl,
    adapter: m?.adapter ?? sharedAdapter,
    mock: m?.mock ?? sharedMock,
    apiKey: process.env[keyEnv] || sharedKey,
    model: m?.model ?? "",
    modelId: m?.modelId ?? defaultModelId,
  });

  return {
    image: merge(g.image, "wanx-standard", "IMAGE_GEN_API_KEY"),
    video: merge(g.video, "kling-standard", "VIDEO_GEN_API_KEY"),
  };
}

/** Image and video providers are built independently from their own resolved
 * config so they can point at different real vendors. Each falls back to its
 * mock when running in mock mode or when no API key is configured. */
export function makeImageProvider(cfg: MediaGenerationConfig): ImageGenerationProvider {
  if (cfg.mock || !cfg.apiKey) return new MockImageGenerationProvider();
  return new HttpImageGenerationProvider({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    adapter: pickImageAdapter(cfg.adapter),
    model: cfg.model,
  });
}

export function makeVideoProvider(cfg: MediaGenerationConfig): VideoGenerationProvider {
  if (cfg.mock || !cfg.apiKey) return new MockVideoGenerationProvider();
  return new HttpVideoGenerationProvider({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    adapter: pickVideoAdapter(cfg.adapter),
    model: cfg.model,
  });
}

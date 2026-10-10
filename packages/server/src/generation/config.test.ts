import { afterEach, describe, it, expect, vi } from "vitest";
import { loadGenerationConfig, loadKlingVoiceConfig, makeKlingVoiceProvider, makeImageProvider, makeVideoProvider, mediaSupportsProgress, type MediaGenerationConfig } from "./config.js";
import {
  OpenAIImagesImageProvider,
  HttpImageGenerationProvider,
  MockImageGenerationProvider,
  HttpVideoGenerationProvider,
  MockVideoGenerationProvider,
} from "@lot-agent/core";

const imageBase: MediaGenerationConfig = { baseUrl: "https://api/v1", apiKey: "", mock: true, adapter: "happyhorse", model: "im", modelId: "wanx-standard" };
const videoBase: MediaGenerationConfig = { baseUrl: "https://api/v1", apiKey: "", mock: true, adapter: "happyhorse", model: "vm", modelId: "kling-standard" };

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("loadGenerationConfig", () => {
  it("uses OPENAI_BASE_URL for both image and video instead of config URLs", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://env.example/v1");
    const cfg = await loadGenerationConfig(process.cwd());
    expect(cfg.image.baseUrl).toBe("https://env.example/v1");
    expect(cfg.video.baseUrl).toBe("https://env.example/v1");
  });

  it("does not fall back to config/default.json's generation URL when env is empty", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "");
    const cfg = await loadGenerationConfig(process.cwd());
    expect(cfg.image.baseUrl).toBe("https://tokenhub.todoucloud.com/v1");
    expect(cfg.video.baseUrl).toBe("https://tokenhub.todoucloud.com/v1");
  });
});

describe("makeImageProvider", () => {
  it("mock:true → MockImageGenerationProvider", () => {
    expect(makeImageProvider(imageBase)).toBeInstanceOf(MockImageGenerationProvider);
  });
  it("mock:false + key → HttpImageGenerationProvider", () => {
    expect(makeImageProvider({ ...imageBase, mock: false, apiKey: "k" })).toBeInstanceOf(HttpImageGenerationProvider);
  });
  it("mock:false + key + openai-images adapter → OpenAIImagesImageProvider", () => {
    expect(makeImageProvider({ ...imageBase, mock: false, apiKey: "k", adapter: "openai-images" })).toBeInstanceOf(OpenAIImagesImageProvider);
  });
  it("keeps the former chat-completions adapter as an OpenAI Images alias", () => {
    expect(makeImageProvider({ ...imageBase, mock: false, apiKey: "k", adapter: "chat-completions" })).toBeInstanceOf(OpenAIImagesImageProvider);
  });
  it("mock:false + no key → falls back to mock", () => {
    expect(makeImageProvider({ ...imageBase, mock: false, apiKey: "" })).toBeInstanceOf(MockImageGenerationProvider);
  });
});

describe("mediaSupportsProgress", () => {
  it("synchronous OpenAI Images provider reports no progress", () => {
    expect(mediaSupportsProgress({ ...imageBase, mock: false, apiKey: "k", adapter: "openai-images" })).toBe(false);
  });
  it("async create→poll provider reports progress", () => {
    expect(mediaSupportsProgress({ ...imageBase, mock: false, apiKey: "k", adapter: "happyhorse" })).toBe(true);
  });
  it("mock provider ramps progress, so it reports progress even for a sync adapter", () => {
    expect(mediaSupportsProgress({ ...imageBase, mock: true, adapter: "openai-images" })).toBe(true);
    expect(mediaSupportsProgress({ ...imageBase, mock: false, apiKey: "", adapter: "openai-images" })).toBe(true);
  });
});

describe("makeVideoProvider", () => {
  it("mock:true → MockVideoGenerationProvider", () => {
    expect(makeVideoProvider(videoBase)).toBeInstanceOf(MockVideoGenerationProvider);
  });
  it("mock:false + key → HttpVideoGenerationProvider", () => {
    expect(makeVideoProvider({ ...videoBase, mock: false, apiKey: "k" })).toBeInstanceOf(HttpVideoGenerationProvider);
  });
  it("mock:false + no key → falls back to mock", () => {
    expect(makeVideoProvider({ ...videoBase, mock: false, apiKey: "" })).toBeInstanceOf(MockVideoGenerationProvider);
  });
});


describe("independent Kling voice configuration", () => {
  it("defaults to Tencent and never inherits an inference or video key", () => {
    vi.stubEnv("KLING_VOICE_BASE_URL", "");
    vi.stubEnv("KLING_VOICE_API_KEY", "");
    vi.stubEnv("OPENAI_BASE_URL", "https://inference.example/v1");
    vi.stubEnv("OPENAI_API_KEY", "llm-secret");
    vi.stubEnv("TOKENHUB_API_KEY", "shared-secret");
    vi.stubEnv("VIDEO_GEN_API_KEY", "video-secret");
    expect(loadKlingVoiceConfig()).toEqual({ baseUrl: "https://tokenhub.tencentmaas.com/v1", apiKey: "" });
    expect(() => makeKlingVoiceProvider(loadKlingVoiceConfig())).toThrow("KLING_VOICE_API_KEY");
  });

  it("loads independent settings without changing image/video configuration", async () => {
    vi.stubEnv("KLING_VOICE_BASE_URL", " https://voice.example/v1 ");
    vi.stubEnv("KLING_VOICE_API_KEY", " voice-secret ");
    vi.stubEnv("OPENAI_BASE_URL", "https://inference.example/v1");
    vi.stubEnv("VIDEO_GEN_API_KEY", "video-secret");
    expect(loadKlingVoiceConfig()).toEqual({ baseUrl: "https://voice.example/v1", apiKey: "voice-secret" });
    const generation = await loadGenerationConfig(process.cwd());
    expect(generation.video.baseUrl).toBe("https://inference.example/v1");
    expect(generation.video.apiKey).toBe("video-secret");
  });

  it("uses only the voice service address and bearer for both create and query", async () => {
    vi.stubEnv("KLING_VOICE_BASE_URL", "https://voice.example/v1/");
    vi.stubEnv("KLING_VOICE_API_KEY", "voice-secret");
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ code: 0, data: { task_id: "t1", task_status: "submitted" } }));
    vi.stubGlobal("fetch", fetcher);
    const provider = makeKlingVoiceProvider(loadKlingVoiceConfig());
    await provider.create({ voiceName: "sample", voiceUrl: "https://media.example/sample.wav", externalTaskId: "e1" });
    await provider.poll("t1");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://voice.example/v1/wand/kling/custom-voices",
      "https://voice.example/v1/wand/kling/custom-voices/t1",
    ]);
    for (const [, init] of fetcher.mock.calls) expect(init.headers.Authorization).toBe("Bearer voice-secret");
  });
});

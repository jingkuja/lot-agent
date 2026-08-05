import { afterEach, describe, it, expect, vi } from "vitest";
import { loadGenerationConfig, makeImageProvider, makeVideoProvider, mediaSupportsProgress, type MediaGenerationConfig } from "./config.js";
import {
  ChatCompletionsImageProvider,
  HttpImageGenerationProvider,
  MockImageGenerationProvider,
  HttpVideoGenerationProvider,
  MockVideoGenerationProvider,
} from "@lot-agent/core";

const imageBase: MediaGenerationConfig = { baseUrl: "https://api/v1", apiKey: "", mock: true, adapter: "happyhorse", model: "im", modelId: "wanx-standard" };
const videoBase: MediaGenerationConfig = { baseUrl: "https://api/v1", apiKey: "", mock: true, adapter: "happyhorse", model: "vm", modelId: "kling-standard" };

afterEach(() => vi.unstubAllEnvs());

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
  it("mock:false + key + chat-completions adapter → ChatCompletionsImageProvider", () => {
    expect(makeImageProvider({ ...imageBase, mock: false, apiKey: "k", adapter: "chat-completions" })).toBeInstanceOf(ChatCompletionsImageProvider);
  });
  it("mock:false + no key → falls back to mock", () => {
    expect(makeImageProvider({ ...imageBase, mock: false, apiKey: "" })).toBeInstanceOf(MockImageGenerationProvider);
  });
});

describe("mediaSupportsProgress", () => {
  it("synchronous chat-completions provider reports no progress", () => {
    expect(mediaSupportsProgress({ ...imageBase, mock: false, apiKey: "k", adapter: "chat-completions" })).toBe(false);
  });
  it("async create→poll provider reports progress", () => {
    expect(mediaSupportsProgress({ ...imageBase, mock: false, apiKey: "k", adapter: "happyhorse" })).toBe(true);
  });
  it("mock provider ramps progress, so it reports progress even for a sync adapter", () => {
    expect(mediaSupportsProgress({ ...imageBase, mock: true, adapter: "chat-completions" })).toBe(true);
    expect(mediaSupportsProgress({ ...imageBase, mock: false, apiKey: "", adapter: "chat-completions" })).toBe(true);
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

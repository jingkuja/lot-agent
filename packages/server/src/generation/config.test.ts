import { describe, it, expect } from "vitest";
import { makeImageProvider, makeVideoProvider, mediaSupportsProgress, type MediaGenerationConfig } from "./config.js";
import {
  ChatCompletionsImageProvider,
  HttpImageGenerationProvider,
  MockImageGenerationProvider,
  HttpVideoGenerationProvider,
  MockVideoGenerationProvider,
} from "@lot-agent/core";

const imageBase: MediaGenerationConfig = { baseUrl: "https://api/v1", apiKey: "", mock: true, adapter: "happyhorse", model: "im", modelId: "wanx-standard" };
const videoBase: MediaGenerationConfig = { baseUrl: "https://api/v1", apiKey: "", mock: true, adapter: "happyhorse", model: "vm", modelId: "kling-standard" };

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

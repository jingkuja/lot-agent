import { describe, it, expect } from "vitest";
import { toOpenAIMessage } from "./openai.js";
import { toAnthropicMessage } from "./anthropic.js";
import type { Message } from "../types/index.js";

const imgUrl = "data:image/png;base64,iVBORw0KGgo=";
const msg: Message = {
  role: "user",
  content: [
    { type: "text", text: "看这张图" },
    { type: "image", image: { url: imgUrl, mediaType: "image/png" } },
  ],
};

describe("toOpenAIMessage", () => {
  it("maps image part to image_url", () => {
    const out = toOpenAIMessage(msg) as { content: any[] };
    expect(out.content).toContainEqual({ type: "image_url", image_url: { url: imgUrl } });
  });
});

describe("toAnthropicMessage", () => {
  it("maps data-url image part to base64 image block", () => {
    const out = toAnthropicMessage(msg) as { content: any[] };
    expect(out.content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });
});

const mediaMsg: Message = {
  role: "user",
  content: [
    { type: "text", text: "看这段视频" },
    { type: "video", media: { url: "https://x/v.mp4", mediaType: "video/mp4", durationSec: 12 } },
  ],
};

describe("multimodal part degradation", () => {
  it("openai degrades an unsupported media part to a text placeholder with the url", () => {
    const out = toOpenAIMessage(mediaMsg) as { content: any[] };
    const hit = out.content.find((p) => p.type === "text" && p.text.includes("v.mp4"));
    expect(hit).toBeDefined();
  });

  it("anthropic degrades an unsupported media part to a text placeholder with the url", () => {
    const out = toAnthropicMessage(mediaMsg) as { content: any[] };
    const hit = out.content.find((p) => p.type === "text" && p.text.includes("v.mp4"));
    expect(hit).toBeDefined();
  });
});

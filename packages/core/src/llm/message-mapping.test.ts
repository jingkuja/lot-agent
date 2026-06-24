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

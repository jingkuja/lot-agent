import { placeholderSvgDataUrl } from "./placeholder.js";

export interface ImageGenRequest {
  prompt: string;
  size?: string;
  quality?: string;
  style?: string;
  n?: number;
  responseFormat?: string;
  model?: string;
}
export interface ImageData {
  url: string;
}
export interface ImageGenResult {
  created: number;
  data: ImageData[];
  usage?: { total_tokens: number };
}
export interface ImageProvider {
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

/** Parse "1024x768" → [1024, 768]; defaults to 1024x1024. */
function parseSize(size?: string): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(size ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [1024, 1024];
}

/** Mock provider: returns OpenAI-shaped result with placeholder SVG data URLs. */
export class MockImageProvider implements ImageProvider {
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    if (/fail/i.test(req.prompt)) throw new Error("mock image failure (prompt contains 'fail')");
    const [w, h] = parseSize(req.size);
    const n = Math.max(1, req.n ?? 1);
    const data = Array.from({ length: n }, () => ({
      url: placeholderSvgDataUrl({ prompt: req.prompt, width: w, height: h, kind: "image" }),
    }));
    return { created: Math.floor(Date.now() / 1000), data, usage: { total_tokens: 0 } };
  }
}

/** Real OpenAI-compatible image provider. */
export class OpenAIImageProvider implements ImageProvider {
  constructor(private opts: { baseUrl: string; apiKey: string; model: string }) {}

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const res = await fetch(`${this.opts.baseUrl}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: req.model ?? this.opts.model,
        prompt: req.prompt,
        size: req.size ?? "1024x1024",
        quality: req.quality ?? "standard",
        style: req.style ?? "vivid",
        n: req.n ?? 1,
        response_format: req.responseFormat ?? "url",
      }),
    });
    if (!res.ok) throw new Error(`image generation failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as ImageGenResult;
  }
}

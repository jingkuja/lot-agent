import { placeholderSvgDataUrl } from "./placeholder.js";

export interface VideoGenRequest {
  prompt: string;
  size?: string;
  durationSec?: number;
  ratio?: string;
  model?: string;
}
export interface VideoGenResult {
  created: number;
  data: { url: string }[];
  durationSec: number;
  usage?: { total_tokens: number };
}
export interface VideoProvider {
  generate(req: VideoGenRequest): Promise<VideoGenResult>;
}

function parseSize(size?: string): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(size ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [832, 480];
}

/** Mock provider: returns an SVG poster data url (no real mp4). */
export class MockVideoProvider implements VideoProvider {
  async generate(req: VideoGenRequest): Promise<VideoGenResult> {
    if (/fail/i.test(req.prompt)) throw new Error("mock video failure (prompt contains 'fail')");
    const [w, h] = parseSize(req.size);
    const durationSec = req.durationSec ?? 5;
    return {
      created: Math.floor(Date.now() / 1000),
      data: [{ url: placeholderSvgDataUrl({ prompt: req.prompt, width: w, height: h, kind: "video" }) }],
      durationSec,
      usage: { total_tokens: 0 },
    };
  }
}

/** Real OpenAI-compatible video provider. */
export class OpenAIVideoProvider implements VideoProvider {
  constructor(private opts: { baseUrl: string; apiKey: string; model: string }) {}

  async generate(req: VideoGenRequest): Promise<VideoGenResult> {
    const res = await fetch(`${this.opts.baseUrl}/video/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: req.model ?? this.opts.model,
        prompt: req.prompt,
        size: req.size,
        duration: req.durationSec,
        ratio: req.ratio,
      }),
    });
    if (!res.ok) throw new Error(`video generation failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as Omit<VideoGenResult, "durationSec">;
    return { ...json, durationSec: req.durationSec ?? 5 };
  }
}

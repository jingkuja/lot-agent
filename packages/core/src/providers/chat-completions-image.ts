import { randomUUID } from "node:crypto";
import type { CreateResult, PollResult } from "./generation-common.js";
import type { ImageGenerationProvider, ImageGenerationRequest } from "./image-generation.js";

/**
 * Pull the first markdown image URL (`![alt](url)`) out of an assistant message,
 * requiring an `http(s)` URL. Returns `null` when there is no image, the URL is
 * relative, or it is a `data:` URI — those all count as a generation failure for
 * the chat-completions image endpoint, whose only output is the markdown link.
 */
export function extractImageUrl(content: string): string | null {
  if (!content) return null;
  const m = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/.exec(content);
  return m ? m[1] : null;
}

export interface ChatCompletionsImageOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Synchronous image provider over tokenhub's OpenAI-style chat-completions
 * endpoint: one POST returns the finished image as a markdown link inside the
 * assistant message. It is adapted to the async `create()/poll()` shape the job
 * runner expects by doing the HTTP work in `create()` and stashing the resulting
 * URL under a synthetic task id (same in-memory pattern as
 * `MockImageGenerationProvider`). A worker crash between create and poll loses
 * the stashed result — acceptable for the platform-foundation stage.
 */
export class ChatCompletionsImageProvider implements ImageGenerationProvider {
  private results = new Map<string, string>();
  constructor(private opts: ChatCompletionsImageOpts) {}

  async create(req: ImageGenerationRequest): Promise<CreateResult> {
    const { baseUrl, apiKey } = this.opts;
    const model = req.model ?? this.opts.model;
    // With reference images, send the OpenAI multimodal content array
    // (`[{ image }, ..., { text }]` — images first, then the prompt); otherwise
    // keep the plain-string content the endpoint accepts for text-only prompts.
    const messageContent =
      req.media && req.media.length > 0
        ? [...req.media.map((m) => ({ image: m.url })), { text: req.prompt }]
        : req.prompt;
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: messageContent }],
      prompt: req.prompt,
    };
    if (req.size) body.size = req.size;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`image generation failed: ${res.status} ${await res.text()}`);

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const url = extractImageUrl(content);
    if (!url) throw new Error("image generation failed: no image url in response");

    const taskId = `cc_${randomUUID()}`;
    this.results.set(taskId, url);
    return { taskId, status: "completed", progress: 100 };
  }

  async poll(taskId: string): Promise<PollResult> {
    const url = this.results.get(taskId);
    if (!url) return { status: "failed", progress: 0, error: "unknown task" };
    return { status: "completed", progress: 100, url };
  }
}

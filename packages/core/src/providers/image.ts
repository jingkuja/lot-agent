export interface ImageGenRequest { prompt: string; size?: string; n?: number; }
export interface ImageGenResult { images: { url: string }[]; raw?: unknown; }
export interface ImageProvider { generate(req: ImageGenRequest): Promise<ImageGenResult>; }

export class StubImageProvider implements ImageProvider {
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    return { images: [{ url: `stub://image?prompt=${encodeURIComponent(req.prompt)}` }] };
  }
}

export interface VideoGenRequest { prompt: string; durationSec?: number; }
export interface VideoGenResult { videoUrl: string; durationSec: number; raw?: unknown; }
export interface VideoProvider { generate(req: VideoGenRequest): Promise<VideoGenResult>; }

export class StubVideoProvider implements VideoProvider {
  async generate(req: VideoGenRequest): Promise<VideoGenResult> {
    const durationSec = req.durationSec ?? 5;
    return { videoUrl: `stub://video?prompt=${encodeURIComponent(req.prompt)}`, durationSec };
  }
}

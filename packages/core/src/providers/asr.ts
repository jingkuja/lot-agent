/**
 * Speech-to-text provider — declared so the video Agent can later caption /
 * transcribe audio-video assets. Real impls (tokenhub whisper-class) live behind
 * this interface; the stub keeps the chain wired without a vendor call.
 */
export interface ASRRequest {
  audioUrl: string;
  language?: string;
}
export interface ASRResult {
  text: string;
  durationSec: number;
  raw?: unknown;
}
export interface ASRProvider {
  transcribe(req: ASRRequest): Promise<ASRResult>;
}

export class StubASRProvider implements ASRProvider {
  async transcribe(req: ASRRequest): Promise<ASRResult> {
    return { text: `[stub transcription of ${req.audioUrl}]`, durationSec: 0 };
  }
}

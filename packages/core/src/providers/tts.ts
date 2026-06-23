export interface TTSRequest { text: string; voice?: string; }
export interface TTSResult { audioUrl: string; characters: number; raw?: unknown; }
export interface TTSProvider { synthesize(req: TTSRequest): Promise<TTSResult>; }

export class StubTTSProvider implements TTSProvider {
  async synthesize(req: TTSRequest): Promise<TTSResult> {
    return { audioUrl: `stub://tts?text=${encodeURIComponent(req.text)}`, characters: req.text.length };
  }
}

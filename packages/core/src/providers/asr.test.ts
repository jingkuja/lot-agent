import { describe, it, expect } from "vitest";
import { StubASRProvider } from "./asr.js";

describe("StubASRProvider", () => {
  it("returns a transcription referencing the audio and a numeric duration", async () => {
    const p = new StubASRProvider();
    const r = await p.transcribe({ audioUrl: "stub://audio/1.mp3" });
    expect(r.text).toContain("stub://audio/1.mp3");
    expect(typeof r.durationSec).toBe("number");
  });
});

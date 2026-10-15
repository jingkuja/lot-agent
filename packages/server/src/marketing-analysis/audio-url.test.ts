import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { SecretBox } from "../auth/secret-box.js";
import { AnalysisStorage } from "./storage.js";
import { analysisAudioUrl, createAnalysisAudioRoutes, withAnalysisAudioUrl } from "./audio-url.js";

it("builds audio URLs from PUBLIC_BASE_URL and rejects absent or credential-bearing origins", () => {
  expect(analysisAudioUrl("https://todoucloud.com/", "/2.wav")).toBe("https://todoucloud.com/2.wav");
  expect(analysisAudioUrl("https://public.test/prefix", "api/public/audio")).toBe("https://public.test/prefix/api/public/audio");
  for (const base of ["", "file:///tmp", "https://user:secret@public.test", "https://public.test/?key=secret"]) expect(() => analysisAudioUrl(base, "2.wav")).toThrow("ASR_PUBLIC_URL_REQUIRED");
});
it("serves only a valid, unexpired task capability and removes the audio after the call", async () => {
  const root = await mkdtemp(join(tmpdir(), "asr-public-"));
  const masterKey = "a".repeat(64); const analysisId = "00000000-0000-4000-8000-000000000001";
  const storage = new AnalysisStorage(root); const directory = await storage.directory("alice", analysisId);
  const app = createAnalysisAudioRoutes(root, masterKey); const audio = Buffer.from("RIFF0000WAVEfixture"); let savedPath = "";
  const tokenPath = (claim: unknown) => "/" + Buffer.from(new SecretBox(masterKey).seal(JSON.stringify(claim))).toString("base64url");
  try {
    await withAnalysisAudioUrl({ directory, ownerId: "alice", analysisId, audio, publicBaseUrl: "https://public.test", masterKey }, async (url, audioHash) => {
      expect(url).toMatch(/^https:\/\/public.test\/api\/public\/marketing-analysis-audio\//);
      savedPath = "/" + url.split("/").at(-1);
      const response = await app.request(savedPath);
      expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toBe("audio/wav");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(audio);
      expect((await app.request(savedPath + "x")).status).toBe(404);
      for (const change of [{ ownerId: "bob" }, { expires: Date.now() - 1 }, { audioHash: "b".repeat(64) }, { analysisId: "../../etc/passwd" }]) {
        expect((await app.request(tokenPath({ ownerId: "alice", analysisId, audioHash, expires: Date.now() + 60000, ...change }))).status).toBe(404);
      }
    });
    expect((await app.request(savedPath)).status).toBe(404);
    await expect(withAnalysisAudioUrl({ directory, ownerId: "alice", analysisId, audio, publicBaseUrl: "https://public.test", masterKey }, async url => {
      savedPath = "/" + url.split("/").at(-1); throw new Error("cancelled");
    })).rejects.toThrow("cancelled");
    expect((await app.request(savedPath)).status).toBe(404);
  } finally { await rm(root, { recursive: true, force: true }); }
});

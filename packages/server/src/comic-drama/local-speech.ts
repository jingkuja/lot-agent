import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechProvider } from "@lot-agent/core";
import { mediaProcess } from "../marketing-video/media.js";

export const COMIC_LOCAL_SPEECH_MODEL = "macos-system-speech";

export function createComicLocalSpeech(): SpeechProvider | undefined {
  if (process.platform !== "darwin" || process.env.COMIC_DRAMA_LOCAL_TTS !== "1") return;
  return {
    async synthesize(request, signal) {
      const options = { signal, timeoutMs: 30_000 };
      const chinese = /\p{Script=Han}/u.test(request.text);
      const male = request.voice === "onyx";
      const names = chinese ? (male ? ["Reed", "Rocko", "Eddy"] : ["Tingting"]) : (male ? ["Reed", "Fred"] : ["Samantha"]);
      const locale = chinese ? "zh_CN" : "en_US";
      const available = await mediaProcess("/usr/bin/say", ["-v", "?"], options);
      const voices = available.split("\n").flatMap(line => {
        const match = /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/.exec(line);
        return match?.[2] === locale ? [match[1]] : [];
      });
      const voice = names.flatMap(name => voices.filter(value => value === name || value.startsWith(name + " (")))[0];
      if (!voice) throw new Error("LOCAL_SPEECH_VOICE_MISSING");
      const dir = await mkdtemp(join(tmpdir(), "lot-comic-speech-"));
      try {
        const input = join(dir, "input.txt"), output = join(dir, "speech.wav");
        // Stop the system synthesizer from interpreting dialogue as embedded speech commands.
        await writeFile(input, request.text.replaceAll("[[", "［［"), { mode: 0o600, signal });
        const rate = Math.round(180 * (request.speed ?? 1));
        await mediaProcess("/usr/bin/say", ["-v", voice, "-r", String(rate), "-f", input, "-o", output,
          "--file-format=WAVE", "--data-format=LEI16@22050"], options);
        return { audio: await readFile(output, { signal }), mime: "audio/wav" };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

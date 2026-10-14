import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { localProbePolicy, localProbeRunner } from "./local-probe.js";
import { startAnalysisEgress } from "./egress.js";
import { analysisMediaRuntime } from "./media-runtime.js";
import { extractAnalysisFrames } from "./frames.js";

const execute = promisify(execFile);
const native = process.platform === "darwin" && process.env.MARKETING_ANALYSIS_LOCAL_SANDBOX_TEST === "1";
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PORT_REQUIRED");
  return address.port;
}
async function close(server: Server) { await new Promise<void>(resolve => server.close(() => resolve())); }

describe("macOS probe and development Worker isolation", () => {
  it.skipIf(!native)("runs the Worker downloader and extracts real video frames through the selected sandbox", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "lot-local-worker-")));
    const signal = new AbortController().signal;
    const media = analysisMediaRuntime({ MARKETING_ANALYSIS_MACOS_SANDBOX: "1", NODE_ENV: "development" });
    try {
      const download = await media.downloadRuntime!(directory, signal);
      try {
        const version = await download.runner.run("yt-dlp", ["--ignore-config", "--no-plugin-dirs", "--version"], signal);
        expect(version.stdout.trim()).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
        expect(download.egress.bytes).toBe(0);
      } finally { await download.egress.close(); }
      const runner = media.decoderRunner(directory);
      await runner.run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=s=64x64:r=2:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", "/work/source.mp4"], signal);
      const frames = await extractAnalysisFrames({ directory, source: { platform: "bilibili", canonicalUrl: "https://www.bilibili.com/video/BV1xx411c7mD", mediaKey: "source.mp4", sourceHash: "a".repeat(64) }, runner, signal });
      expect(frames.frames.length).toBeGreaterThan(0);
      expect(frames.frames[0].ptsMs).toBe(0);
      expect(frames.durationMs).toBe(1000);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30000);

  it.skipIf(!native)("allows task files and only the downloader proxy; denies unrelated files and decoder networking", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "lot-local-isolation-")));
    const work = join(base, "work"); const outside = join(base, "private-canary");
    const proxy = createServer(socket => socket.end()); const direct = createServer(socket => socket.end());
    try {
      await mkdir(work); await writeFile(join(work, "allowed"), "allowed"); await writeFile(outside, "test-only-canary");
      const proxyPort = await listen(proxy); const directPort = await listen(direct);
      const python = await realpath("/opt/homebrew/bin/python3");
      const script = `import json, socket, sys
def permitted(action):
    try:
        action()
        return True
    except OSError:
        return False
def read(path):
    with open(path) as handle: handle.read()
def write(path):
    with open(path, 'w') as handle: handle.write('test-only-canary')
def connect(port):
    with socket.create_connection(('127.0.0.1', int(port)), timeout=1): pass
print(json.dumps({'readTask': permitted(lambda: read(sys.argv[1] + '/allowed')), 'writeTask': permitted(lambda: write(sys.argv[1] + '/created')), 'readOutside': permitted(lambda: read(sys.argv[2])), 'writeOutside': permitted(lambda: write(sys.argv[2])), 'proxy': permitted(lambda: connect(sys.argv[3])), 'direct': permitted(lambda: connect(sys.argv[4]))}))`;
      for (const allowedPort of [undefined, proxyPort]) {
        const { stdout } = await execute("/usr/bin/sandbox-exec", ["-p", localProbePolicy(work, allowedPort), python, "-I", "-c", script, work, outside, String(proxyPort), String(directPort)], {
          cwd: work, env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", TMPDIR: work }, timeout: 10000,
        });
        expect(JSON.parse(stdout)).toEqual({ readTask: true, writeTask: true, readOutside: false, writeOutside: false, proxy: allowedPort !== undefined, direct: false });
      }
    } finally { await close(proxy); await close(direct); await rm(base, { recursive: true, force: true }); }
  }, 30000);

  it.skipIf(!native)("cancels an active native decoder process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lot-local-cancel-"));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      await expect(localProbeRunner(directory).run("ffmpeg", ["-nostdin", "-v", "error", "-re", "-f", "lavfi", "-i", "color=size=16x16:rate=1", "-t", "60", "-f", "null", "/dev/null"], controller.signal)).rejects.toThrow("PROCESS_CANCELLED");
    } finally { clearTimeout(timer); await rm(directory, { recursive: true, force: true }); }
  }, 10000);

  it.skipIf(!native)("reports a rejected plaintext proxy request as network blocked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lot-local-egress-"));
    const socketPath = join(directory, "egress.sock");
    const egress = await startAnalysisEgress(socketPath, { signal: new AbortController().signal, maxBytes: 1024 });
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request({ socketPath, path: "http://cdn.example.test/video.mp4" }, res => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
        req.once("error", reject); req.end();
      });
      expect(status).toBe(403); expect(egress.failure).toBe("NETWORK_BLOCKED"); expect(egress.bytes).toBe(0);
    } finally { await egress.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

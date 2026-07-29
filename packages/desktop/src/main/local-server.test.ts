import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeServer, startLocalServer, type LocalServerHandle } from "./local-server.js";

/**
 * Integration tests for the loopback server: a fake "remote" upstream plus a
 * tmp web dist dir. Covers static hosting, SPA fallback, the setup flow, and
 * — most importantly — streaming proxy behavior for SSE and uploads.
 */

let upstream: http.Server;
let upstreamPort: number;
let upstreamUrl: string;
let distDir: string;
let handle: LocalServerHandle | null;
let base: string;

/** Mutable config the loopback server reads on every request. */
let serverUrl: string | null;
let savedUrl: string | null;

function upstreamHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  if (req.url === "/api/auth/mode") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"debug":false,"user":null}');
    return;
  }
  if (req.url === "/spa/health-like") {
    // Mimics the production nginx falling through to the SPA index.html.
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>not an api</html>");
    return;
  }
  if (req.url === "/api/echo" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": req.headers["content-type"] ?? "application/octet-stream",
        "x-echo-authorization": String(req.headers.authorization ?? ""),
      });
      res.end(Buffer.concat(chunks));
    });
    return;
  }
  if (req.url === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    setTimeout(() => {
      res.write("data: two\n\n");
      setTimeout(() => {
        res.write("data: three\n\n");
        res.end();
      }, 30);
    }, 30);
    return;
  }
  if (req.url?.startsWith("/static/assets/")) {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from([1, 2, 3]));
    return;
  }
  res.writeHead(404);
  res.end("nope");
}

beforeEach(async () => {
  serverUrl = null;
  savedUrl = null;
  handle = null;

  upstream = http.createServer(upstreamHandler);
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as { port: number }).port;
  upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

  distDir = fs.mkdtempSync(path.join(os.tmpdir(), "lot-dist-"));
  fs.writeFileSync(path.join(distDir, "index.html"), "<h1>app</h1>");
  fs.mkdirSync(path.join(distDir, "assets"));
  fs.writeFileSync(path.join(distDir, "assets", "app.js"), "console.log(1)");

  serverUrl = upstreamUrl;
  handle = await startLocalServer({
    webDistDir: distDir,
    getServerUrl: () => serverUrl,
    onServerUrlChange: async (url) => {
      savedUrl = url;
      serverUrl = url;
      return { ok: true };
    },
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle?.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  fs.rmSync(distDir, { recursive: true, force: true });
});

describe("probeServer", () => {
  it("accepts a real Lot Agent backend", async () => {
    expect(await probeServer(upstreamUrl)).toEqual({ ok: true });
  });

  it("rejects addresses that answer 200 but aren't the API (SPA fallback)", async () => {
    const result = await probeServer(`${upstreamUrl}/spa`);
    // /spa/api/auth/mode doesn't exist upstream → 404
    expect(result.ok).toBe(false);
  });

  it("rejects unreachable servers with a message", async () => {
    const result = await probeServer("http://127.0.0.1:1", 1000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("无法连接服务器");
  });
});

describe("static hosting", () => {
  it("serves index.html at /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<h1>app</h1>");
  });

  it("serves assets with the right mime type", async () => {
    const res = await fetch(`${base}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toBe("console.log(1)");
  });

  it("falls back to index.html for unknown routes (SPA)", async () => {
    const res = await fetch(`${base}/some/deep/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>app</h1>");
  });

  it("rejects path traversal outside the dist dir", async () => {
    // Place a secret next to the dist dir and try to escape with encoded
    // slashes (%2f survives URL parsing, unlike plain ../ which the URL
    // parser normalizes away before we ever see it).
    const secretName = `lot-secret-${process.pid}.txt`;
    fs.writeFileSync(path.join(path.dirname(distDir), secretName), "topsecret");
    try {
      const res = await fetch(`${base}/%2e%2e%2f${secretName}`);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("topsecret");
    } finally {
      fs.rmSync(path.join(path.dirname(distDir), secretName), { force: true });
    }
  });
});

describe("proxy", () => {
  it("proxies GET /api to the configured server", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404); // upstream's 404, not a local one
  });

  it("pipes POST bodies (uploads) and forwards auth headers", async () => {
    const payload = Buffer.alloc(256 * 1024, 7); // 256KB binary-ish body
    const res = await fetch(`${base}/api/echo`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        authorization: "Bearer tok",
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-echo-authorization")).toBe("Bearer tok");
    const echoed = Buffer.from(await res.arrayBuffer());
    expect(echoed.equals(payload)).toBe(true);
  });

  it("streams SSE chunks progressively without buffering", async () => {
    const res = await fetch(`${base}/api/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("data: one");
    // The first chunk must arrive before the upstream has finished.
    const second = await reader.read();
    expect(second.done).toBe(false);

    let rest = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    expect(rest).toContain("data: three");
  });

  it("proxies /static to the remote server", async () => {
    const res = await fetch(`${base}/static/assets/x.png`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  });

  it("returns 502 when the server url is not configured", async () => {
    serverUrl = null;
    const res = await fetch(`${base}/api/echo`, { method: "POST", body: "x" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("未配置");
  });
});

describe("setup flow", () => {
  it("serves the setup page on / when no server is configured", async () => {
    serverUrl = null;
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("连接服务器");
  });

  it("still serves static assets while unconfigured", async () => {
    serverUrl = null;
    const res = await fetch(`${base}/assets/app.js`);
    expect(res.status).toBe(200);
  });

  it("POST /__lot/config saves the url and the app loads afterwards", async () => {
    serverUrl = null;
    const res = await fetch(`${base}/__lot/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverUrl: upstreamUrl }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(savedUrl).toBe(upstreamUrl);

    const home = await fetch(`${base}/`);
    expect(await home.text()).toBe("<h1>app</h1>");
  });

  it("rejects a config post without serverUrl", async () => {
    const res = await fetch(`${base}/__lot/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

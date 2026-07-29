import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { renderSetupPage } from "./setup-page.js";

/**
 * Loopback server hosted by the Electron main process. It does two jobs:
 *
 * 1. Serves the built web app (`packages/web/dist`) over
 *    `http://127.0.0.1:<port>` — a secure context, so WebCrypto (RSA login)
 *    works and the renderer never touches `file://`.
 * 2. Reverse-proxies `/api/*`, `/static/*` and `/health` to the configured
 *    remote Lot Agent server, streaming in both directions (SSE responses and
 *    multipart uploads are piped, never buffered).
 *
 * Because the page and the API share one origin, the web app needs **zero**
 * desktop-specific URL handling and there is no CORS involvement at all.
 */

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

export interface LocalServerOptions {
  /** Directory containing the built web app (index.html + assets). */
  webDistDir: string;
  getServerUrl: () => string | null;
  /** Validates + persists a new server url (the loopback server itself is
   * stateless w.r.t. config; the caller owns the config store). */
  onServerUrlChange: (url: string) => Promise<{ ok: boolean; error?: string }>;
  host?: string;
  port?: number;
}

export interface LocalServerHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * Probes the server's public `/api/auth/mode` endpoint. Deliberately NOT
 * `/health`: behind the production nginx, `/health` can fall through to the
 * SPA's index.html and return 200+HTML for addresses that aren't a Lot Agent
 * backend at all.
 */
export async function probeServer(
  url: string,
  timeoutMs = 5000
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${url}/api/auth/mode`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `服务器返回 ${res.status}` };
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return { ok: false, error: "该地址不是 Lot Agent 服务端" };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `无法连接服务器：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

/** Streams the request/response through to the configured remote server. */
function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  base: string
): void {
  const target = `${base}${req.url}`;
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    sendJson(res, 502, { error: "服务器地址无效" });
    return;
  }
  const transport = targetUrl.protocol === "https:" ? https : http;

  // Strip origin/referer: to the browser this is a same-origin request, but
  // the remote server's CORS middleware shouldn't see a loopback origin.
  const headers: Record<string, string | string[] | undefined> = {
    ...req.headers,
    host: targetUrl.host,
  };
  delete headers.origin;
  delete headers.referer;

  const upstream = transport.request(
    targetUrl,
    { method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      res.flushHeaders(); // SSE: headers out immediately, then stream chunks
      up.pipe(res);
    }
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: `无法连接服务器：${error.message}`,
      });
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
}

function serveStatic(
  res: http.ServerResponse,
  distDir: string,
  pathname: string
): void {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }
  if (rel === "/" || rel === "") rel = "/index.html";

  const root = path.resolve(distDir);
  const file = path.resolve(root, `.${rel}`);
  if (file !== root && !file.startsWith(root + path.sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback: unknown non-asset paths get index.html.
      fs.readFile(path.join(root, "index.html"), (indexErr, index) => {
        if (indexErr) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        sendHtml(res, 200, index.toString("utf8"));
      });
      return;
    }
    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(file).toLowerCase()] ??
        "application/octet-stream",
      // Hashed vite assets are immutable; index.html is not.
      "cache-control": rel.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
    res.end(data);
  });
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startLocalServer(
  options: LocalServerOptions
): Promise<LocalServerHandle> {
  const host = options.host ?? "127.0.0.1";

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${host}`);
      const pathname = url.pathname;

      // ── Loopback-only control endpoints ──────────────────────────────────
      if (pathname === "/__lot/config" && req.method === "POST") {
        try {
          const body = JSON.parse(await readBody(req)) as { serverUrl?: string };
          if (!body.serverUrl) {
            sendJson(res, 400, { ok: false, error: "服务器地址不能为空" });
            return;
          }
          const result = await options.onServerUrlChange(body.serverUrl);
          sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (pathname === "/__lot/state") {
        sendJson(res, 200, { serverUrl: options.getServerUrl() });
        return;
      }
      if (pathname === "/__lot/setup") {
        sendHtml(res, 200, renderSetupPage(options.getServerUrl()));
        return;
      }

      // ── Proxied API / static files from the remote server ────────────────
      if (
        pathname === "/health" ||
        pathname.startsWith("/api/") ||
        pathname.startsWith("/static/")
      ) {
        const base = options.getServerUrl();
        if (!base) {
          sendJson(res, 502, { error: "服务器地址未配置" });
          return;
        }
        proxyRequest(req, res, base);
        return;
      }

      // ── First run: no server configured → setup page for any navigation ──
      if (!options.getServerUrl() && req.method === "GET" && !path.extname(pathname)) {
        sendHtml(res, 200, renderSetupPage(null));
        return;
      }

      // ── The web app itself ────────────────────────────────────────────────
      serveStatic(res, options.webDistDir, pathname);
    })().catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        res.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

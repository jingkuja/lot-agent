import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const FALLBACK_TARGET = "http://localhost:3000";

/**
 * When the Electron shell is running, its "服务器设置" modal persists the
 * chosen backend to the app's userData/config.json. Read it per request so
 * the dev proxy follows the same server the packaged app would use (the
 * loopback server does the same in prod). Falls back to localhost:3000.
 */
function desktopServerUrl(): string | null {
  try {
    const dir =
      process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "Lot Agent")
        : process.platform === "win32"
          ? path.join(
              process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
              "Lot Agent"
            )
          : path.join(
              process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
              "Lot Agent"
            );
    const cfg = JSON.parse(
      fs.readFileSync(path.join(dir, "config.json"), "utf8")
    ) as { serverUrl?: unknown };
    return typeof cfg.serverUrl === "string" && cfg.serverUrl
      ? cfg.serverUrl
      : null;
  } catch {
    return null;
  }
}

/**
 * Dev proxy for /api + /static with a per-request dynamic target. Vite's
 * built-in `proxy` option is static (and its bundled http-proxy ignores the
 * `router` option), so we pipe the streams ourselves — same behavior as the
 * desktop shell's loopback proxy: headers flushed immediately (SSE), bodies
 * piped both ways (uploads), origin/referer stripped.
 */
function devProxyPlugin(): Plugin {
  const proxyRequest = (
    req: Connect.IncomingMessage,
    res: http.ServerResponse,
    base: string
  ) => {
    const target = new URL(req.url ?? "/", base);
    const transport = target.protocol === "https:" ? https : http;
    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: target.host,
    };
    delete headers.origin;
    delete headers.referer;

    const upstream = transport.request(
      target,
      { method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        res.flushHeaders();
        up.pipe(res);
      }
    );
    upstream.on("error", (error) => {
      console.error("[lot-dev-proxy]", req.url, error.message);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `无法连接服务器：${error.message}` }));
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  };

  return {
    name: "lot-dev-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        if (
          url === "/health" ||
          url.startsWith("/api/") ||
          url.startsWith("/static/")
        ) {
          proxyRequest(req, res, desktopServerUrl() ?? FALLBACK_TARGET);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devProxyPlugin()],
  // Relative asset URLs so the same dist works when served from the nginx root,
  // the desktop shell's loopback server, or opened via file:// for debugging.
  base: "./",
  server: {
    port: 5173,
  },
});

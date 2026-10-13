import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const FALLBACK_TARGET = "http://localhost:3000";

/**
 * Desktop development reads the Electron server setting per request, just
 * like the packaged shell. Ordinary web development must stay on the local
 * API: a previously saved desktop setting may point at an older deployment.
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
function devProxyPlugin(mode: string): Plugin {
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
    // Forward renderer disconnects so Stop also aborts the remote agent run.
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
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
          proxyRequest(req, res, mode === "desktop" ? desktopServerUrl() ?? FALLBACK_TARGET : FALLBACK_TARGET);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), devProxyPlugin(mode)],
  // Relative asset URLs so the same dist works when served from the nginx root,
  // the desktop shell's loopback server, or opened via file:// for debugging.
  base: "./",
  server: {
    // Let a phone or another machine on the LAN open the dev workspace via
    // this machine's IP address. The API remains behind the same Vite proxy.
    host: "0.0.0.0",
    // Vite rejects unknown Host headers by default. Permit the deployment
    // domain when it is reverse-proxied to this local dev server.
    allowedHosts: ["aigc.todoucloud.com","todoucloud.com"],
    port: 5173,
  },
}));

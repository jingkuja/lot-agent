import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connect, Plugin, ViteDevServer } from "vite";
import createConfig from "./vite.config.js";

afterEach(() => vi.restoreAllMocks());

async function proxy(mode: string) {
  if (typeof createConfig !== "function") throw new Error("Expected a mode-aware Vite config");
  const config = await createConfig({ command: "serve", mode });
  const plugin = config.plugins?.find(p => (p as Plugin)?.name === "lot-dev-proxy") as Plugin;
  let handle: Connect.NextHandleFunction;
  const configure = plugin.configureServer as (server: ViteDevServer) => void;
  configure({ middlewares: { use: (middleware: Connect.NextHandleFunction) => { handle = middleware; } } } as ViteDevServer);
  const local = vi.spyOn(http, "request").mockImplementation(() => new PassThrough() as unknown as http.ClientRequest);
  const remote = vi.spyOn(https, "request").mockImplementation(() => new PassThrough() as unknown as http.ClientRequest);
  const send = () => {
    const req = Object.assign(new PassThrough(), { url: "/api/marketing-videos", method: "GET", headers: {} });
    handle(req as Connect.IncomingMessage, new EventEmitter() as http.ServerResponse, vi.fn());
    req.end();
  };
  return { local, remote, send };
}

describe("development API proxy routing", () => {
  it("keeps ordinary web development local despite a saved desktop server", async () => {
    const f = await proxy("development");
    const read = vi.spyOn(fs, "readFileSync").mockReturnValue('{"serverUrl":"https://old.example"}');
    f.send();
    expect(String(f.local.mock.calls[0][0])).toBe("http://localhost:3000/api/marketing-videos");
    expect(read).not.toHaveBeenCalled();
    expect(f.remote).not.toHaveBeenCalled();
  });

  it("follows desktop server changes per request only in desktop mode", async () => {
    const f = await proxy("desktop");
    const read = vi.spyOn(fs, "readFileSync").mockReturnValue('{"serverUrl":"https://first.example"}');
    f.send();
    read.mockReturnValue('{"serverUrl":"https://second.example"}');
    f.send();
    expect(f.remote.mock.calls.map(call => String(call[0]))).toEqual([
      "https://first.example/api/marketing-videos", "https://second.example/api/marketing-videos",
    ]);
    expect(f.local).not.toHaveBeenCalled();
  });

  it("falls back to the local API when desktop configuration is unavailable", async () => {
    const f = await proxy("desktop");
    vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("ENOENT"); });
    f.send();
    expect(String(f.local.mock.calls[0][0])).toBe("http://localhost:3000/api/marketing-videos");
  });
});

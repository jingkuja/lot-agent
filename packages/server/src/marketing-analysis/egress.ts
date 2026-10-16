import { createServer } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { chmod, rm } from "node:fs/promises";
import { resolvePublicUrl } from "@lot-agent/core";
import { AnalysisError } from "./errors.js";

/** No DNS rebinding: resolve once per connection, validate every answer,
 * then connect to the selected numeric address. HTTPS only; no CONNECT to
 * arbitrary ports, no absolute HTTP requests, no private-host exceptions. */
export async function resolveEgressTarget(authority: string, resolve = resolvePublicUrl) {
  if (!/^[a-zA-Z0-9.-]+:443$/.test(authority)) throw new AnalysisError("NETWORK_BLOCKED");
  const host = authority.slice(0, -4);
  if (isIP(host) || host.endsWith(".") || !host.includes(".")) throw new AnalysisError("NETWORK_BLOCKED");
  const addresses = await resolve(`https://${host}`);
  for (const { address, family } of addresses) {
    // Use globally routed IPv4 only. This also excludes mapped IPv6,
    // translation ranges, multicast, documentation and reserved networks.
    const [a, b, c] = address.split(".").map(Number);
    if (family !== 4 || isIP(address) !== 4 || a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c)) || (b === 88 && c === 99))) || (a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113)) throw new AnalysisError("NETWORK_BLOCKED");
  }
  if (!addresses.length) throw new AnalysisError("NETWORK_BLOCKED");
  return addresses[0];
}

export async function startAnalysisEgress(path: string, options: { signal: AbortSignal; maxBytes: number; maxConnections?: number }) {
  // A rendered page needs concurrent script/CDN connections. Callers may opt
  // into at most 64 tunnels; the destination and byte policies are unchanged.
  const maxConnections = options.maxConnections ?? 8;
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 64) throw new AnalysisError("SANDBOX_REQUIRED", 503);
  const sockets = new Set<Socket>(); let bytes = 0; let failure: string | undefined; let closed = false;
  const stop = () => { for (const socket of sockets) socket.destroy(); };
  const server = createServer((_req, res) => { failure = "NETWORK_BLOCKED"; res.writeHead(403); res.end(); });
  server.maxConnections = maxConnections;
  server.maxHeadersCount = 20; server.headersTimeout = 5000; server.requestTimeout = 10000;
  server.on("connection", socket => { sockets.add(socket); socket.setTimeout(30000, () => socket.destroy()); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
  server.on("connect", (request, client, head) => {
    client.on("error", () => {});
    if (sockets.size > maxConnections * 2 || closed || bytes >= options.maxBytes || options.signal.aborted) { client.destroy(); return; }
    void (async () => {
      const address = await resolveEgressTarget(request.url ?? "", url => resolvePublicUrl(url, { resolve: async hostname => {
        const { lookup } = await import("node:dns/promises");
        // AF_INET deliberately avoids accepting IPv6 translation/transition addresses.
        return lookup(hostname, { all: true, family: 4 });
      } }));
      if (closed || options.signal.aborted || client.destroyed) return;
      const upstream = connect({ host: address.address, family: address.family, port: 443 });
      sockets.add(upstream); upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => { sockets.delete(upstream); client.destroy(); });
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > options.maxBytes) { failure = "DOWNLOAD_LIMIT"; stop(); }
      });
    })().catch(() => { failure = "NETWORK_BLOCKED"; client.destroy(); });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  options.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); }); });
  await chmod(path, 0o600);
  options.signal.addEventListener("abort", stop, { once: true });
  return {
    get bytes() { return bytes; }, get failure() { return failure; },
    async close() { closed = true; options.signal.removeEventListener("abort", stop); stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(path, { force: true }); },
  };
}

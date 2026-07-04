import { lookup as dnsLookup } from "node:dns/promises";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface NetGuardOptions {
  /** Injectable for tests; defaults to node:dns/promises lookup. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Hostnames allowed to resolve to a private address (self-hosted deployments). */
  allowHosts?: string[];
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
  if (lower.startsWith("fe80")) return true; // link-local
  return false;
}

/** True if `ip` (of the given address `family`, 4 or 6) is a private/loopback/link-local address. */
export function isPrivateAddress(ip: string, family: number): boolean {
  return family === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true });
}

/**
 * Resolves `url`'s host and throws `SsrfError` if any resolved address is
 * private/loopback/link-local, unless the hostname is explicitly allow-listed.
 */
export async function assertPublicUrl(
  url: string,
  opts: NetGuardOptions = {}
): Promise<void> {
  const parsed = new URL(url);
  if (opts.allowHosts?.includes(parsed.hostname)) return;

  const resolve = opts.resolve ?? defaultResolve;
  const addrs = await resolve(parsed.hostname);
  if (addrs.length === 0) {
    throw new SsrfError(`could not resolve host: ${parsed.hostname}`);
  }
  for (const { address, family } of addrs) {
    if (isPrivateAddress(address, family)) {
      throw new SsrfError(
        `refusing to fetch private/internal address: ${address} (host: ${parsed.hostname})`
      );
    }
  }
}

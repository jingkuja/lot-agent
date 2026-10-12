import fs from "node:fs";
import path from "node:path";

export interface DesktopConfig {
  /** Explicit or previously selected remote server origin. */
  serverUrl?: string;
  /** Server to which the encrypted session token belongs. */
  tokenServerUrl?: string;
  /** Close button hides to the tray instead of quitting. */
  minimizeToTray?: boolean;
}

/**
 * Normalizes user-typed server addresses: adds a default `http://` scheme,
 * strips trailing slashes, and rejects anything that isn't a valid http(s)
 * URL. Throws with a user-facing Chinese message on invalid input.
 */
export function normalizeServerUrl(input: string): string {
  let url = input.trim();
  if (!url) throw new Error("服务器地址不能为空");
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(url);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) {
    throw new Error("仅支持 http/https 协议");
  }
  if (!schemeMatch) url = `http://${url}`;
  url = url.replace(/\/+$/, "");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("服务器地址格式不正确");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 协议");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("服务器地址仅支持域名和端口，不能包含账号、路径、查询参数或片段");
  }
  return parsed.origin;
}

export function readConfig(file: string): DesktopConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (raw && typeof raw === "object") return raw as DesktopConfig;
    return {};
  } catch {
    return {};
  }
}

export function writeConfig(file: string, config: DesktopConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
}


export const DEFAULT_SERVER_URL = "https://todoucloud.com";

/** Both --server-url=https://host and --server-url https://host are accepted. */
export function serverUrlArgument(argv: readonly string[]): string | undefined {
  let result: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== "--server-url" && !arg.startsWith("--server-url=")) continue;
    if (result !== undefined) throw new Error("--server-url 只能指定一次");
    const value = arg === "--server-url" ? argv[++i] : arg.slice("--server-url=".length);
    if (!value || value.startsWith("--")) throw new Error("--server-url 需要服务器地址");
    result = normalizeServerUrl(value);
  }
  return result;
}

export function resolveServerUrl(options: {
  argv: readonly string[];
  config: DesktopConfig;
  isDev: boolean;
  bundledDefault?: string;
}): string {
  const commandLine = serverUrlArgument(options.argv);
  if (commandLine) return commandLine;
  if (typeof options.config.serverUrl === "string") {
    try { return normalizeServerUrl(options.config.serverUrl); } catch { /* Ignore corrupt legacy config. */ }
  }
  return normalizeServerUrl(options.isDev ? "http://localhost:3000" : options.bundledDefault ?? DEFAULT_SERVER_URL);
}

/** Legacy tokens are preserved only when their saved server matches. */
export function tokenMatchesServer(config: DesktopConfig, serverUrl: string): boolean {
  const previous = config.tokenServerUrl ?? config.serverUrl;
  if (typeof previous !== "string") return false;
  try { return normalizeServerUrl(previous) === serverUrl; } catch { return false; }
}

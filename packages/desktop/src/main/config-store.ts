import fs from "node:fs";
import path from "node:path";

export interface DesktopConfig {
  /** Remote Lot Agent server origin, e.g. `http://192.168.1.10` or
   * `https://agent.example.com`. Undefined until the user completes the
   * first-run server setup. */
  serverUrl?: string;
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
  return url;
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

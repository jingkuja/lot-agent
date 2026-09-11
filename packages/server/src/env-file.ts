import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Parse a dotenv-format string into a key/value map.
 * Supports `export KEY=`, quoted values, and `#` comments.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]!;
      let i = 1;
      let out = "";
      while (i < value.length) {
        const ch = value[i]!;
        if (quote === '"' && ch === "\\") {
          const next = value[i + 1];
          if (next === undefined) break;
          if (next === "n") out += "\n";
          else if (next === "r") out += "\r";
          else if (next === "t") out += "\t";
          else out += next;
          i += 2;
          continue;
        }
        if (ch === quote) break;
        out += ch;
        i += 1;
      }
      value = out;
    } else {
      const hash = value.search(/\s+#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    result[key] = value;
  }
  return result;
}

/**
 * Copy parsed dotenv values into `env`. Existing keys are left alone unless
 * `override` is true, so Docker/K8s/shell exports still win.
 */
export function applyDotEnv(
  vars: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
  override = false,
): void {
  for (const [key, value] of Object.entries(vars)) {
    if (override || env[key] === undefined) env[key] = value;
  }
}

/** Walk parents of each start directory looking for a `.env` file. */
export function findEnvPath(starts: string[]): string | undefined {
  const seen = new Set<string>();
  for (const start of starts) {
    let dir = resolve(start);
    while (!seen.has(dir)) {
      seen.add(dir);
      const candidate = resolve(dir, ".env");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/**
 * Load the nearest repo `.env` into `process.env`. No-ops when the file is
 * missing (production containers get env from compose/K8s, not a file).
 */
export function loadRepoEnv(opts?: {
  env?: NodeJS.ProcessEnv;
  override?: boolean;
  fromUrl?: string;
}): string | undefined {
  const env = opts?.env ?? process.env;
  // Vitest must not inherit the developer's secrets / local DB settings.
  if (env.VITEST) return undefined;
  const here = dirname(fileURLToPath(opts?.fromUrl ?? import.meta.url));
  const path = findEnvPath([process.cwd(), here]);
  if (!path) return undefined;
  applyDotEnv(parseDotEnv(readFileSync(path, "utf8")), env, opts?.override ?? false);
  return path;
}

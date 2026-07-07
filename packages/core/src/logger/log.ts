/**
 * Minimal leveled, structured logger (E6). JSON-line output, one record per
 * call, filtered by level (LOG_LEVEL env by default). No dependency, no
 * transports — a single `write` sink (stderr by default) keeps it embeddable
 * in core, replacing scattered `console.warn/error`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that stamps `bindings` onto every record. */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  /** Minimum level to emit. Default: LOG_LEVEL env, else "info". */
  level?: LogLevel;
  /** Fields stamped onto every record. */
  bindings?: LogFields;
  /** Sink for a finished JSON line. Default: process.stderr. */
  write?: (line: string) => void;
  /** Timestamp source (injectable for tests). Default: ISO now. */
  now?: () => string;
}

function normalizeLevel(v: string | undefined, fallback: LogLevel): LogLevel {
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : fallback;
}

/** Make fields JSON-safe: unwrap Errors to their message. */
function normalizeFields(fields?: LogFields): LogFields {
  if (!fields) return {};
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? v.message : v;
  }
  return out;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? normalizeLevel(process.env.LOG_LEVEL, "info");
  const threshold = RANK[level];
  const write = opts.write ?? ((line: string) => process.stderr.write(line + "\n"));
  const now = opts.now ?? (() => new Date().toISOString());
  const bindings = opts.bindings ?? {};

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
    if (RANK[lvl] < threshold) return;
    const record = {
      level: lvl,
      time: now(),
      msg,
      ...bindings,
      ...normalizeFields(fields),
    };
    write(JSON.stringify(record));
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (childBindings) =>
      createLogger({ ...opts, level, bindings: { ...bindings, ...childBindings } }),
  };
}

/** Process-wide default logger. */
export const logger = createLogger();

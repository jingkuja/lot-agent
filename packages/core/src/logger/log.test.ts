import { describe, it, expect } from "vitest";
import { createLogger } from "./log.js";

function capture() {
  const lines: string[] = [];
  return { lines, write: (l: string) => lines.push(l) };
}

describe("createLogger", () => {
  it("emits a JSON line with level, msg and merged fields", () => {
    const sink = capture();
    const log = createLogger({ level: "debug", write: sink.write, now: () => "T" });
    log.info("hello", { userId: "u1" });

    expect(sink.lines).toHaveLength(1);
    const rec = JSON.parse(sink.lines[0]);
    expect(rec).toMatchObject({ level: "info", msg: "hello", userId: "u1", time: "T" });
  });

  it("filters out messages below the configured level", () => {
    const sink = capture();
    const log = createLogger({ level: "warn", write: sink.write });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    const levels = sink.lines.map((l) => JSON.parse(l).level);
    expect(levels).toEqual(["warn", "error"]);
  });

  it("child() merges bindings into every record", () => {
    const sink = capture();
    const log = createLogger({ level: "debug", write: sink.write }).child({ mod: "skills" });
    log.warn("failed", { file: "a.md" });

    const rec = JSON.parse(sink.lines[0]);
    expect(rec).toMatchObject({ level: "warn", msg: "failed", mod: "skills", file: "a.md" });
  });

  it("defaults to the LOG_LEVEL env when no level is passed", () => {
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "error";
    try {
      const sink = capture();
      const log = createLogger({ write: sink.write });
      log.warn("w");
      log.error("e");
      expect(sink.lines.map((l) => JSON.parse(l).level)).toEqual(["error"]);
    } finally {
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
  });

  it("serializes an Error field to its message", () => {
    const sink = capture();
    const log = createLogger({ level: "debug", write: sink.write });
    log.error("boom", { err: new Error("kaboom") });
    const rec = JSON.parse(sink.lines[0]);
    expect(rec.err).toBe("kaboom");
  });
});

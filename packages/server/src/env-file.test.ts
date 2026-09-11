import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDotEnv, findEnvPath, parseDotEnv } from "./env-file.js";

describe("parseDotEnv", () => {
  it("skips comments and blank lines", () => {
    expect(parseDotEnv("# hi\n\nFOO=bar\n  # x\n")).toEqual({ FOO: "bar" });
  });

  it("accepts export prefix and quoted values", () => {
    expect(
      parseDotEnv(`export REDIS_URL='redis://localhost:6379/1'\nNAME="a b"\n`),
    ).toEqual({
      REDIS_URL: "redis://localhost:6379/1",
      NAME: "a b",
    });
  });

  it("strips unquoted inline comments and unescapes double quotes", () => {
    expect(parseDotEnv(`A=one # c\nB="say \\"hi\\""\n`)).toEqual({
      A: "one",
      B: 'say "hi"',
    });
  });

  it("ignores invalid keys", () => {
    expect(parseDotEnv("=no\n1BAD=x\nOK=yes\n")).toEqual({ OK: "yes" });
  });
});

describe("applyDotEnv", () => {
  it("fills missing keys and leaves existing ones alone", () => {
    const env: NodeJS.ProcessEnv = { KEEP: "old" };
    applyDotEnv({ KEEP: "new", ADD: "yes" }, env);
    expect(env).toEqual({ KEEP: "old", ADD: "yes" });
  });

  it("overwrites when override is true", () => {
    const env: NodeJS.ProcessEnv = { KEEP: "old" };
    applyDotEnv({ KEEP: "new" }, env, true);
    expect(env.KEEP).toBe("new");
  });
});

describe("findEnvPath", () => {
  it("walks up from a nested directory to the nearest .env", () => {
    const root = mkdtempSync(join(tmpdir(), "lot-env-"));
    try {
      writeFileSync(join(root, ".env"), "FOO=1\n");
      const nested = join(root, "packages", "server");
      mkdirSync(nested, { recursive: true });
      expect(findEnvPath([nested])).toBe(join(root, ".env"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixture: string;
beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "lot desktop scripts ")));
  mkdirSync(join(fixture, "scripts"));
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe("desktop platform scripts", () => {
  it("starts in development mode from a path with spaces and forwards arguments and exit status", () => {
    copyFileSync(new URL("./dev.mjs", import.meta.url), join(fixture, "scripts", "dev.mjs"));
    const electronDir = join(fixture, "node_modules", "electron");
    mkdirSync(electronDir, { recursive: true });
    writeFileSync(join(electronDir, "package.json"), JSON.stringify({ main: "index.cjs" }));
    // Substitute only the installed executable; run the actual launcher in a subprocess.
    writeFileSync(join(electronDir, "index.cjs"), "module.exports = process.execPath;");
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ main: "app.cjs" }));
    writeFileSync(join(fixture, "app.cjs"), 'console.log(JSON.stringify({ dev: process.env.LOT_DESKTOP_DEV, args: process.argv.slice(2), cwd: process.cwd() })); process.exitCode = 7;');
    const args = ["--server-url=https://desktop.example", "value with spaces & symbols"];
    const result = spawnSync(process.execPath, [join(fixture, "scripts", "dev.mjs"), ...args], {
      cwd: tmpdir(), env: { ...process.env, LOT_DESKTOP_DEV: "0" }, encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout.trim())).toEqual({ dev: "1", args, cwd: fixture });
  });

  it("cleans only package build outputs even when started from another directory", () => {
    copyFileSync(new URL("./clean.mjs", import.meta.url), join(fixture, "scripts", "clean.mjs"));
    for (const directory of ["dist", "release", "keep"]) {
      mkdirSync(join(fixture, directory));
      writeFileSync(join(fixture, directory, "file.txt"), "fixture");
    }
    const result = spawnSync(process.execPath, [join(fixture, "scripts", "clean.mjs")], { cwd: tmpdir() });
    expect(result.status).toBe(0);
    expect(existsSync(join(fixture, "dist"))).toBe(false);
    expect(existsSync(join(fixture, "release"))).toBe(false);
    expect(existsSync(join(fixture, "keep", "file.txt"))).toBe(true);
  });
});

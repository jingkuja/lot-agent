import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeServerUrl,
  serverUrlArgument,
  resolveServerUrl,
  tokenMatchesServer,
  readConfig,
  writeConfig,
} from "./config-store.js";

describe("normalizeServerUrl", () => {
  it("adds http:// when the scheme is missing", () => {
    expect(normalizeServerUrl("192.168.1.10")).toBe("http://192.168.1.10");
    expect(normalizeServerUrl("agent.example.com:8080")).toBe(
      "http://agent.example.com:8080"
    );
  });

  it("keeps http/https schemes and strips trailing slashes", () => {
    expect(normalizeServerUrl("https://agent.example.com/")).toBe(
      "https://agent.example.com"
    );
    expect(normalizeServerUrl("http://box:3000///")).toBe("http://box:3000");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeServerUrl("  http://box  ")).toBe("http://box");
  });

  it("rejects empty input", () => {
    expect(() => normalizeServerUrl("")).toThrow("服务器地址不能为空");
    expect(() => normalizeServerUrl("   ")).toThrow("服务器地址不能为空");
  });

  it("rejects non-http schemes and garbage", () => {
    expect(() => normalizeServerUrl("ftp://box")).toThrow("仅支持 http/https");
    expect(() => normalizeServerUrl("http://")).toThrow();
  });
});

describe("readConfig / writeConfig", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lot-config-"));
    file = path.join(dir, "config.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns {} when the file does not exist", () => {
    expect(readConfig(file)).toEqual({});
  });

  it("round-trips the config", () => {
    writeConfig(file, { serverUrl: "http://box:3000", minimizeToTray: true });
    expect(readConfig(file)).toEqual({
      serverUrl: "http://box:3000",
      minimizeToTray: true,
    });
  });

  it("creates missing parent directories", () => {
    const nested = path.join(dir, "a", "b", "config.json");
    writeConfig(nested, { serverUrl: "http://box" });
    expect(readConfig(nested).serverUrl).toBe("http://box");
  });

  it("returns {} on corrupt JSON", () => {
    fs.writeFileSync(file, "{not json");
    expect(readConfig(file)).toEqual({});
  });

  it("returns {} on non-object JSON", () => {
    fs.writeFileSync(file, '"just a string"');
    expect(readConfig(file)).toEqual({});
  });
});

describe("desktop server selection", () => {
  it("launches a fresh packaged install against todoucloud without setup", () => {
    expect(resolveServerUrl({ argv: [], config: {}, isDev: false })).toBe("https://todoucloud.com");
    expect(resolveServerUrl({ argv: [], config: {}, isDev: true })).toBe("http://localhost:3000");
  });
  it("uses command-line > saved config > bundled default", () => {
    const options = { argv: [], config: {}, isDev: false, bundledDefault: "https://bundled.example" };
    expect(resolveServerUrl(options)).toBe("https://bundled.example");
    expect(resolveServerUrl({ ...options, config: { serverUrl: "https://saved.example" } })).toBe("https://saved.example");
    expect(resolveServerUrl({ ...options, config: { serverUrl: "https://saved.example" }, argv: ["app", "--server-url", "https://launch.example/"] })).toBe("https://launch.example");
    expect(serverUrlArgument(["--server-url=https://launch.example/"])).toBe("https://launch.example");
  });
  it("rejects incomplete, duplicated or unsafe command arguments", () => {
    for (const argv of [["--server-url"], ["--server-url="], ["--server-url", "--other"], ["--server-url=https://one.example", "--server-url=https://two.example"], ["--server-url=file:///tmp"], ["--server-url=https://user:password@example.com"], ["--server-url=https://example.com/path"], ["--server-url=https://example.com?token=secret"]]) {
      expect(() => serverUrlArgument(argv)).toThrow();
    }
    expect(serverUrlArgument(["--some-electron-flag"])).toBeUndefined();
  });
  it("falls back safely for malformed saved settings", () => {
    expect(resolveServerUrl({ argv: [], config: { serverUrl: "ftp://bad" }, isDev: false })).toBe("https://todoucloud.com");
  });
  it("never sends a session token to a newly selected server", () => {
    expect(tokenMatchesServer({}, "https://todoucloud.com")).toBe(false);
    expect(tokenMatchesServer({ serverUrl: "https://old.example" }, "https://todoucloud.com")).toBe(false);
    expect(tokenMatchesServer({ serverUrl: "https://todoucloud.com/" }, "https://todoucloud.com")).toBe(true);
    expect(tokenMatchesServer({ serverUrl: "https://todoucloud.com", tokenServerUrl: "https://other.example" }, "https://todoucloud.com")).toBe(false);
  });
});

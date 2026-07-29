import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeServerUrl,
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

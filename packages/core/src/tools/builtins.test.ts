import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  webFetchTool,
  readFileTool,
  writeFileTool,
  listFilesTool,
  executeCommandTool,
  searchFilesTool,
  registerBuiltinTools,
} from "./builtins.js";
import * as netFetch from "./net-fetch.js";
import { ToolRegistry } from "./registry.js";
import type { ToolContext } from "../types/index.js";

const ctx: ToolContext = { workingDirectory: process.cwd() };

describe("web_fetch SSRF guard", () => {
  it("refuses to fetch a loopback address", async () => {
    const result = await webFetchTool.execute({ url: "http://127.0.0.1:1/" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("private");
  });

  it("refuses to fetch the cloud metadata address", async () => {
    const result = await webFetchTool.execute(
      { url: "http://169.254.169.254/latest/meta-data/" },
      ctx
    );
    expect(result.isError).toBe(true);
  });

  it("rejects a non-http(s) URL before attempting any resolution", async () => {
    const result = await webFetchTool.execute({ url: "file:///etc/passwd" }, ctx);
    expect(result.isError).toBe(true);
  });
});

describe("web_fetch response text", () => {
  const url = "https://example.com/announcement";

  afterEach(() => vi.restoreAllMocks());

  it.each(["Application/PDF; charset=binary", "application/octet-stream"])("extracts a PDF served as %s", async (mime) => {
    const body = Buffer.from("%PDF-1.7\n\0binary");
    vi.spyOn(netFetch, "fetchPublicBinary").mockResolvedValue({ body, mime });
    const extractPdfText = vi.fn().mockResolvedValue("公告正文");
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, { includeHostTools: false, extractPdfText });

    await expect(registry.execute("web_fetch", { url }, ctx)).resolves.toEqual({ content: "公告正文" });
    expect(extractPdfText).toHaveBeenCalledWith(body, expect.any(AbortSignal));
  });

  it("returns a tool error when a PDF cannot be parsed", async () => {
    vi.spyOn(netFetch, "fetchPublicBinary").mockResolvedValue({ body: Buffer.from("broken\0"), mime: "application/pdf" });
    const registry = new ToolRegistry();
    const extractPdfText = vi.fn().mockRejectedValue(new Error("PARSER_FAILED"));
    registerBuiltinTools(registry, { includeHostTools: false, extractPdfText });

    await expect(registry.execute("web_fetch", { url }, ctx)).resolves.toEqual({
      content: "Could not extract readable PDF text; try another source", isError: true, errorKind: "validation",
    });
    expect(extractPdfText).toHaveBeenCalledTimes(1);
    await expect(webFetchTool.execute({ url }, ctx)).resolves.toMatchObject({ isError: true, errorKind: "validation" });
  });

  it("strips NUL and does not split a Unicode character when truncating", async () => {
    vi.spyOn(netFetch, "fetchPublicBinary").mockResolvedValue({ body: Buffer.from("字\0😀尾"), mime: "text/plain" });

    await expect(webFetchTool.execute({ url }, ctx)).resolves.toEqual({ content: "字😀尾" });
    await expect(webFetchTool.execute({ url, maxChars: 2 }, ctx)).resolves.toEqual({ content: "字\n\n... (truncated, 4 chars total)" });
  });
});

describe("path containment", () => {
  it("rejects reading outside the working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lot-agent-test-"));
    const result = await readFileTool.execute(
      { path: "../../etc/passwd" },
      { workingDirectory: dir }
    );
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("permission");
    await rm(dir, { recursive: true, force: true });
  });

  it("allows reading a file inside a subdirectory of the working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lot-agent-test-"));
    await writeFile(join(dir, "f.txt"), "hello");
    const result = await readFileTool.execute({ path: "f.txt" }, { workingDirectory: dir });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("hello");
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects writing outside the working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lot-agent-test-"));
    const result = await writeFileTool.execute(
      { path: "../escape.txt", content: "x" },
      { workingDirectory: dir }
    );
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("permission");
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects listing outside the working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lot-agent-test-"));
    const result = await listFilesTool.execute({ path: ".." }, { workingDirectory: dir });
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("permission");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("execute_command cancellation", () => {
  it("aborts a long-running command promptly when the signal fires", async () => {
    const controller = new AbortController();
    const cmdCtx: ToolContext = { workingDirectory: process.cwd(), signal: controller.signal };
    const start = Date.now();
    const promise = executeCommandTool.execute({ command: "sleep", args: ["5"] }, cmdCtx);
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    const elapsed = Date.now() - start;
    expect(result.isError).toBe(true);
    expect(elapsed).toBeLessThan(2000); // aborted promptly, not after the full 5s sleep
  });
});

describe("web_fetch cancellation", () => {
  it("rejects immediately when the run signal is already aborted, without hitting the network", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const result = await webFetchTool.execute(
      { url: "http://example.com/" },
      { workingDirectory: process.cwd(), signal: controller.signal }
    );
    const elapsed = Date.now() - start;
    expect(result.isError).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });
});

describe("search_files pattern handling", () => {
  it("does not treat a dash-prefixed pattern as a grep option", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lot-agent-test-"));
    await writeFile(join(dir, "notes.txt"), "line one\n-foo bar\nline three\n");
    const result = await searchFilesTool.execute(
      { pattern: "-foo" },
      { workingDirectory: dir }
    );
    expect(result.isError).toBeUndefined();
    expect(result.content.toLowerCase()).not.toContain("invalid option");
    expect(result.content).toContain("-foo bar");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("symlink escape containment", () => {
  it("rejects reading a file reached through a symlink that escapes the working directory", async () => {
    const outerDir = await mkdtemp(join(tmpdir(), "lot-agent-outer-"));
    await writeFile(join(outerDir, "secret.txt"), "top secret");

    const workDir = await mkdtemp(join(tmpdir(), "lot-agent-work-"));
    await symlink(outerDir, join(workDir, "escape-link"), "dir");

    const result = await readFileTool.execute(
      { path: "escape-link/secret.txt" },
      { workingDirectory: workDir }
    );
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("permission");

    await rm(workDir, { recursive: true, force: true });
    await rm(outerDir, { recursive: true, force: true });
  });

  it("still allows reading a normal file inside the working directory", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "lot-agent-work-"));
    await writeFile(join(workDir, "f.txt"), "hello");
    const result = await readFileTool.execute({ path: "f.txt" }, { workingDirectory: workDir });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("hello");
    await rm(workDir, { recursive: true, force: true });
  });

  it("still allows listing a subdirectory inside the working directory", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "lot-agent-work-"));
    await mkdir(join(workDir, "sub"));
    await writeFile(join(workDir, "sub", "a.txt"), "x");
    const result = await listFilesTool.execute({ path: "sub" }, { workingDirectory: workDir });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("a.txt");
    await rm(workDir, { recursive: true, force: true });
  });
});

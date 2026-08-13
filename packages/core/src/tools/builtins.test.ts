import { describe, it, expect } from "vitest";
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
} from "./builtins.js";
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

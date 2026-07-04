import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  webFetchTool,
  readFileTool,
  writeFileTool,
  listFilesTool,
  executeCommandTool,
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

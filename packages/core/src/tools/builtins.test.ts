import { describe, it, expect } from "vitest";
import { webFetchTool } from "./builtins.js";
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

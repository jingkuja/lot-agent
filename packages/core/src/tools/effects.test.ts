import { expect, it, vi } from "vitest";
import { ToolRegistry } from "./registry.js";
import { classifyToolFailure } from "./errors.js";

it("distinguishes a non-retryable read timeout from an uncertain write", async () => {
  const registry = new ToolRegistry();
  for (const effect of ["read", "write"] as const) registry.register({
    name: effect, effect, description: "", parameters: {}, execConfig: { timeoutMs: 5 },
    execute: async () => new Promise(() => {}),
  });
  expect(await registry.execute("read", {}, { workingDirectory: "/tmp" })).toMatchObject({ errorKind: "timeout" });
  expect(await registry.execute("write", {}, { workingDirectory: "/tmp" })).toMatchObject({ errorKind: "unknown_outcome" });
});

it("preserves a wrapped connection error and never retries the write", async () => {
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => classifyToolFailure(new Error("storage failed", { cause: new Error("ECONNRESET after commit") }), "create"));
  // retrySafe alone must never imply read-only or permit replay after a lost acknowledgement.
  registry.register({ name: "write", retrySafe: true, description: "", parameters: {}, execute });
  expect(await registry.execute("write", {}, { workingDirectory: "/tmp" })).toMatchObject({ errorKind: "unknown_outcome" });
  expect(execute).toHaveBeenCalledOnce();
});

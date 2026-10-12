import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, symlink, link, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeLocalTool, localPath } from "./local-tools.js";

let root: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "lot-local-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "lot-outside-")));
});
afterEach(async () => { await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); });
const run = (name: string, input: unknown, approve = vi.fn(async () => true), signal = new AbortController().signal) => executeLocalTool(root, { id: "op", name, input }, signal, approve);

describe("desktop local files", () => {
  it("creates, reads, edits and lists files", async () => {
    expect((await run("desktop_write_file", { path: "a.txt", content: "hello world" })).isError).toBeUndefined();
    expect((await run("desktop_read_file", { path: "a.txt" })).content).toBe("hello world");
    expect((await run("desktop_edit_file", { path: "a.txt", oldText: "world", newText: "desktop" })).isError).toBeUndefined();
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("hello desktop");
    expect((await run("desktop_list_files", {})).content).toContain("a.txt");
  });
  it("rejects traversal, symlinks, hardlinks and unknown tools", async () => {
    await writeFile(join(outside, "secret"), "secret");
    await symlink(outside, join(root, "escape"));
    await link(join(outside, "secret"), join(root, "hardlink"));
    for (const path of ["../secret", join(outside, "secret"), "escape/secret", "hardlink"]) {
      expect((await run("desktop_read_file", { path })).isError).toBe(true);
    }
    expect((await run("desktop_write_file", { path: "escape/new", content: "x" })).isError).toBe(true);
    expect((await run("execute_command", { command: "pwd" })).errorKind).toBe("validation");
  });
  it("refuses malformed inputs, existing files and ambiguous edits", async () => {
    await writeFile(join(root, "a"), "same same");
    expect((await run("desktop_write_file", { path: "a", content: "replace" })).errorKind).toBe("validation");
    expect((await run("desktop_edit_file", { path: "a", oldText: "same", newText: "x" })).errorKind).toBe("validation");
    expect((await run("desktop_bash", { command: "pwd", timeoutMs: -1 })).errorKind).toBe("validation");
    expect((await run("desktop_read_file", { path: "a", extra: true })).errorKind).toBe("validation");
    expect(await readFile(join(root, "a"), "utf8")).toBe("same same");
  });
  it("preserves external edits made during approval", async () => {
    await writeFile(join(root, "a"), "before");
    const result = await run("desktop_edit_file", { path: "a", oldText: "before", newText: "after" }, vi.fn(async () => { await writeFile(join(root, "a"), "external"); return true; }));
    expect(result.isError).toBe(true);
    expect(await readFile(join(root, "a"), "utf8")).toBe("external");
  });
  it("does not execute declined or cancelled operations", async () => {
    expect((await run("desktop_write_file", { path: "a", content: "x" }, vi.fn(async () => false))).errorKind).toBe("permission");
    const controller = new AbortController();
    const approval = vi.fn(async () => { controller.abort(); return true; });
    expect((await run("desktop_bash", { command: "touch unwanted" }, approval, controller.signal)).isError).toBe(true);
    expect((await run("desktop_list_files", {})).content).toBe("(empty directory)");
  });
  it("rejects binary and oversized files", async () => {
    await writeFile(join(root, "binary"), Buffer.from([0, 1]));
    await writeFile(join(root, "large"), "x".repeat(1024 * 1024 + 1));
    for (const path of ["binary", "large"]) expect((await run("desktop_read_file", { path })).isError).toBe(true);
  });
  it("detects replacement of the selected root with a symlink", async () => {
    const nested = join(root, "nested");
    await mkdir(nested);
    await rm(nested, { recursive: true });
    await symlink(outside, nested);
    await expect(localPath(nested, "a")).rejects.toThrow("Workspace changed");
  });
  it.skipIf(process.platform === "win32")("runs Bash and cancels its process group", async () => {
    const result = await run("desktop_bash", { command: "printf hello" });
    expect(result.content).toContain("hello");
    expect(result.isError).toBe(false);
    const controller = new AbortController();
    const promise = run("desktop_bash", { command: "sleep 20" }, vi.fn(async () => true), controller.signal);
    setTimeout(() => controller.abort(), 150);
    expect((await promise).errorKind).toBe("unknown_outcome");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, symlink, link, rm, realpath, readdir } from "node:fs/promises";
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
const windows = process.platform === "win32";
const shellTool = windows ? "desktop_powershell" : "desktop_bash";
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
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
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
    expect((await run(shellTool, { command: "pwd", timeoutMs: -1 })).errorKind).toBe("validation");
    expect((await run("desktop_read_file", { path: "a", extra: true })).errorKind).toBe("validation");
    expect(await readFile(join(root, "a"), "utf8")).toBe("same same");
  });
  it("preserves external edits made during approval", async () => {
    await writeFile(join(root, "a"), "before");
    const result = await run("desktop_edit_file", { path: "a", oldText: "before", newText: "after" }, vi.fn(async () => { await writeFile(join(root, "a"), "external"); return true; }));
    expect(result.isError).toBe(true);
    expect(await readFile(join(root, "a"), "utf8")).toBe("external");
  });
  it("rejects a parent replaced with a link while approval is pending", async () => {
    await mkdir(join(root, "nested"));
    const approve = vi.fn(async () => {
      await rm(join(root, "nested"), { recursive: true });
      await symlink(outside, join(root, "nested"), process.platform === "win32" ? "junction" : "dir");
      return true;
    });
    expect((await run("desktop_write_file", { path: "nested/new.txt", content: "blocked" }, approve)).errorKind).toBe("permission");
    expect(await readdir(outside)).toEqual([]);
  });
  it("does not execute declined or cancelled operations", async () => {
    expect((await run("desktop_write_file", { path: "a", content: "x" }, vi.fn(async () => false))).errorKind).toBe("permission");
    const controller = new AbortController();
    const approval = vi.fn(async () => { controller.abort(); return true; });
    expect((await run(shellTool, { command: windows ? "Set-Content unwanted x" : "touch unwanted" }, approval, controller.signal)).isError).toBe(true);
    expect((await run("desktop_list_files", {})).content).toBe("(empty directory)");
  });
  it("preserves Chinese paths, spaces and CRLF line endings while editing", async () => {
    const path = "项目 资料/测试 文件.txt";
    await mkdir(join(root, "项目 资料"));
    expect((await run("desktop_write_file", { path, content: "第一行\r\n第二行\r\n" })).isError).toBeUndefined();
    expect((await run("desktop_edit_file", { path, oldText: "第二行", newText: "修改后" })).isError).toBeUndefined();
    expect(await readFile(join(root, path), "utf8")).toBe("第一行\r\n修改后\r\n");
    expect(await readdir(join(root, "项目 资料"))).toEqual(["测试 文件.txt"]);
  });
  it("does not modify files after denied or cancelled edit approval", async () => {
    await writeFile(join(root, "fixture.txt"), "original");
    const input = { path: "fixture.txt", oldText: "original", newText: "changed" };
    expect((await run("desktop_edit_file", input, vi.fn(async () => false))).errorKind).toBe("permission");
    const controller = new AbortController();
    const result = await run("desktop_edit_file", input, vi.fn(async () => { controller.abort(); return true; }), controller.signal);
    expect(result.isError).toBe(true);
    expect(await readFile(join(root, "fixture.txt"), "utf8")).toBe("original");
    expect(await readdir(root)).toEqual(["fixture.txt"]);
  });
  it("rejects missing parent directories, invalid UTF-8 and unknown tools", async () => {
    expect((await run("desktop_write_file", { path: "missing/file.txt", content: "text" })).errorKind).toBe("not_found");
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    expect((await run("desktop_read_file", { path: "invalid.txt" })).isError).toBe(true);
    expect((await run("desktop_remove_file", { path: "invalid.txt" })).errorKind).toBe("validation");
    expect(await readFile(join(root, "invalid.txt"))).toEqual(Buffer.from([0xc3, 0x28]));
  });
  it("rejects binary and oversized files", async () => {
    await writeFile(join(root, "binary"), Buffer.from([0, 1]));
    await writeFile(join(root, "large"), "x".repeat(1024 * 1024 + 1));
    for (const path of ["binary", "large"]) expect((await run("desktop_read_file", { path })).isError).toBe(true);
  });
  it("deletes a single file without any shell and requires approval", async () => {
    const path = "待删除 文件.bin";
    await writeFile(join(root, path), Buffer.from([0, 1, 2]));
    expect((await run("desktop_delete_file", { path }, vi.fn(async () => false))).errorKind).toBe("permission");
    expect(await readFile(join(root, path))).toEqual(Buffer.from([0, 1, 2]));
    const approve = vi.fn(async (_detail: string) => true);
    expect((await run("desktop_delete_file", { path }, approve)).isError).toBeUndefined();
    expect(approve.mock.calls[0][0]).toContain("Permanently delete");
    await expect(readFile(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await run("desktop_delete_file", { path })).errorKind).toBe("not_found");
  });
  it("never recursively deletes directories or escapes the selected workspace", async () => {
    await writeFile(join(outside, "safe.txt"), "keep");
    await mkdir(join(root, "nested"));
    await symlink(outside, join(root, "escape"), windows ? "junction" : "dir");
    await link(join(outside, "safe.txt"), join(root, "hardlink"));
    for (const path of [".", "nested", "../safe.txt", join(outside, "safe.txt"), "escape/safe.txt", "hardlink"]) {
      const approve = vi.fn(async () => true);
      expect((await run("desktop_delete_file", { path }, approve)).isError).toBe(true);
      expect(approve).not.toHaveBeenCalled();
    }
    expect(await readFile(join(outside, "safe.txt"), "utf8")).toBe("keep");
  });
  it("preserves changed files and cancelled deletions", async () => {
    await writeFile(join(root, "file.txt"), "original");
    const changed = await run("desktop_delete_file", { path: "file.txt" }, vi.fn(async () => { await writeFile(join(root, "file.txt"), "external edit"); return true; }));
    expect(changed.errorKind).toBe("validation");
    const controller = new AbortController();
    expect((await run("desktop_delete_file", { path: "file.txt" }, vi.fn(async () => { controller.abort(); return true; }), controller.signal)).isError).toBe(true);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("external edit");
  });
  it("detects replacement of the selected root with a symlink", async () => {
    const nested = join(root, "nested");
    await mkdir(nested);
    await rm(nested, { recursive: true });
    await symlink(outside, nested, process.platform === "win32" ? "junction" : "dir");
    await expect(localPath(nested, "a")).rejects.toThrow("Workspace changed");
  });
  it("runs the native system shell and cancels it without Git", async () => {
    const result = await run(shellTool, { command: windows ? "Write-Output hello" : "printf hello" });
    expect(result.content).toContain("hello");
    expect(result.isError).toBe(false);
    const controller = new AbortController();
    const promise = run(shellTool, { command: windows ? "Start-Sleep -Seconds 20" : "sleep 20" }, vi.fn(async () => true), controller.signal);
    setTimeout(() => controller.abort(), 150);
    expect((await promise).errorKind).toBe("unknown_outcome");
  });
  it("requires approval before deleting a fixture through the system shell", async () => {
    const path = "待删除 文件.txt";
    await writeFile(join(root, path), "fixture only");
    const input = { command: windows ? "Remove-Item -LiteralPath '待删除 文件.txt'" : "rm -- '待删除 文件.txt'" };
    expect((await run(shellTool, input, vi.fn(async () => false))).errorKind).toBe("permission");
    expect(await readFile(join(root, path), "utf8")).toBe("fixture only");
    const approval = vi.fn(async () => true);
    expect((await run(shellTool, input, approval)).isError).toBe(false);
    expect(approval).toHaveBeenCalledOnce();
    await expect(readFile(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cancels an already started child process before it can write later", async () => {
    const controller = new AbortController();
    const childScript = Buffer.from("[IO.File]::WriteAllText('ready.txt','ready'); Start-Sleep -Seconds 2; [IO.File]::WriteAllText('late.txt','unexpected')", "utf16le").toString("base64");
    const command = windows
      ? `$child = Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${childScript}' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -PassThru; $child.WaitForExit()`
      : "(printf ready > ready.txt; sleep 2; printf unexpected > late.txt) & wait";
    const running = run(shellTool, { command }, vi.fn(async () => true), controller.signal);
    await vi.waitFor(async () => expect(await readFile(join(root, "ready.txt"), "utf8")).toBe("ready"), { timeout: 3000 });
    controller.abort();
    expect((await running).errorKind).toBe("unknown_outcome");
    await new Promise(resolve => setTimeout(resolve, 2200));
    await expect(readFile(join(root, "late.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 10000);
  it("reports timed out commands as uncertain instead of retrying them", async () => {
    const result = await run(shellTool, { command: windows ? "Start-Sleep -Seconds 20" : "sleep 20", timeoutMs: 1000 });
    expect(result.errorKind).toBe("unknown_outcome");
    expect(result.content).toContain("timed out");
  });
});

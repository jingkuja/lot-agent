import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { validLocalInput } from "../../../core/src/desktop/protocol.js";

const mocks = vi.hoisted(() => ({ access: vi.fn(), spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({ access: mocks.access }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { executeShell, findLocalShell, shellArguments, shellCandidates } from "./local-shell.js";

const realProcess = process;
const child = () => Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(undefined);
  vi.stubGlobal("process", { ...realProcess, platform: "win32", env: { SYSTEMROOT: "C:\\Windows", PATH: "C:\\system-path", API_KEY: "fixture-secret", BASH_ENV: "untrusted-startup", PSModulePath: "untrusted-modules" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("native Windows shell", () => {
  it("uses built-in PowerShell without searching Git, WSL or PATH", async () => {
    expect(await findLocalShell()).toEqual({ kind: "powershell", executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" });
    expect(shellCandidates("bash", "win32")).toEqual([]);
    expect(shellCandidates("powershell", "darwin")).toEqual([]);
    expect(shellCandidates("bash", "darwin")).toEqual(["/bin/bash", "/usr/bin/bash"]);
    expect(shellCandidates("powershell", "win32", { SystemRoot: "D:\\Windows" })[0]).toMatch(/^D:\\Windows\\/);
  });
  it("preserves Unicode and quotes while disabling profiles and interaction", () => {
    const command = "Write-Output '你好 文件'; Write-Output \"a & b\"";
    const args = shellArguments("powershell", command);
    expect(args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-EncodedCommand"]));
    expect(args).not.toContain("-ExecutionPolicy");
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain(command);
    expect(script).toContain("UTF8Encoding");
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain("exit $LASTEXITCODE");
    expect(shellArguments("powershell", "x".repeat(10000)).join(" ").length).toBeLessThan(30000);
    expect(validLocalInput("desktop_powershell", { command: "x".repeat(10001) })).toBe(false);
  });
  it("uses a restricted environment and decodes UTF-8 output", async () => {
    const processChild = child();
    mocks.spawn.mockReturnValue(processChild);
    const running = executeShell("powershell", "Write-Output '你好'", "C:\\项目 资料", 30000, new AbortController().signal);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    const [executable, args, options] = mocks.spawn.mock.calls[0];
    expect(executable).toMatch(/WindowsPowerShell/);
    expect(args).toContain("-EncodedCommand");
    expect(options).toMatchObject({ cwd: "C:\\项目 资料", detached: false, windowsHide: true, env: { PATH: "C:\\system-path", SYSTEMROOT: "C:\\Windows" } });
    expect(options.env).not.toHaveProperty("API_KEY");
    expect(options.env).not.toHaveProperty("BASH_ENV");
    expect(options.env).not.toHaveProperty("PSModulePath");
    processChild.stdout.write("你好\n");
    processChild.emit("close", 0);
    expect(await running).toEqual({ content: "你好\n\n[exit: 0]", isError: false });
  });
  it("cancels with taskkill for the process tree and reports an uncertain outcome", async () => {
    const processChild = child();
    const killer = child();
    mocks.spawn.mockReturnValueOnce(processChild).mockReturnValueOnce(killer);
    const controller = new AbortController();
    const running = executeShell("powershell", "Start-Sleep 20", "C:\\workspace", 30000, controller.signal);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    controller.abort();
    expect(mocks.spawn.mock.calls[1]).toEqual(["C:\\Windows\\System32\\taskkill.exe", ["/pid", "42", "/T", "/F"], { windowsHide: true, stdio: "ignore" }]);
    killer.emit("close", 1);
    expect(processChild.kill).toHaveBeenCalledOnce();
    processChild.emit("close", null);
    expect((await running).errorKind).toBe("unknown_outcome");
  });
  it("fails closed when the shell is unavailable or the requested dialect differs", async () => {
    expect((await executeShell("bash", "rm file", "C:\\workspace", 30000, new AbortController().signal)).errorKind).toBe("permission");
    mocks.access.mockRejectedValue(new Error("unavailable"));
    expect(await findLocalShell()).toBeNull();
    expect((await executeShell("powershell", "Get-ChildItem", "C:\\workspace", 30000, new AbortController().signal)).isError).toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

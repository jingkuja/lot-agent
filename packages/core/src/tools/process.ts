import { spawn } from "node:child_process";

/** A tool command owns its process group: cancellation must include descendants. */
export function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { reject(opts.signal.reason ?? new Error("Aborted")); return; }
    const child = spawn(command, args, {
      cwd: opts.cwd, detached: process.platform !== "win32", windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let stopped = false;
    let killTask: Promise<void> = Promise.resolve();
    const stop = (reason: Error) => {
      if (stopped) return;
      stopped = true;
      failure = reason;
      if (!child.pid) return;
      if (process.platform === "win32") {
        killTask = new Promise<void>(done => {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => { child.kill("SIGKILL"); done(); });
          killer.once("close", () => done());
        });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }
    };
    const onAbort = () => stop(Object.assign(new Error("Command aborted"), { name: "AbortError" }));
    const timer = setTimeout(() => stop(new Error("Command timed out")), opts.timeout);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    const receive = (parts: Buffer[]) => (data: Buffer) => {
      bytes += data.length;
      if (bytes > opts.maxBuffer) stop(new Error("Command output exceeds maxBuffer"));
      else parts.push(data);
    };
    child.stdout.on("data", receive(stdout));
    child.stderr.on("data", receive(stderr));
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", (code, signal) => {
      cleanup();
      void killTask.then(() => {
        const output = { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
        if (failure || code !== 0) reject(Object.assign(failure ?? new Error(`Command exited with ${code ?? signal}`), output));
        else resolve(output);
      });
    });
  });
}

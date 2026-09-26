import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./process.js";

it("cancels descendants, not just the direct child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lot-process-"));
  const ready = join(dir, "ready");
  const marker = join(dir, "marker");
  const child = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),600)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const abort = new AbortController();
  const work = runCommand(process.execPath, ["-e", parent], { cwd: dir, signal: abort.signal, timeout: 3000, maxBuffer: 1024 });
  const outcome = work.catch(error => error);
  try {
    for (let i = 0; i < 100; i++) {
      if (await readFile(ready, "utf8").catch(() => "") === "ready") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await readFile(ready, "utf8")).toBe("ready");
    abort.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(await readFile(marker, "utf8").catch(() => "absent")).toBe("absent");
  } finally {
    abort.abort();
    await outcome;
    await rm(dir, { recursive: true, force: true });
  }
});

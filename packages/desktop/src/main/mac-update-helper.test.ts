import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
let root: string, target: string, stage: string, backup: string, operation: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mac update test "));
  target = path.join(root, "Lot Agent.app"); stage = path.join(root, "stage.app");
  operation = path.join(root, "operation"); backup = path.join(operation, "previous.app");
  for (const p of [target, stage, operation]) await mkdir(p);
  await writeFile(path.join(target, "version"), "old");
  await writeFile(path.join(stage, "version"), "new");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function run(mode: "success" | "failure", pid = "999999999") {
  // Exercise real moves and recovery in temporary directories. Only substitute
  // the OS app launcher and wait duration; never launch or replace real apps.
  const launcher = path.join(root, "open-fixture");
  await writeFile(launcher, '#!/bin/bash\nif [ "$1" = "-n" ] && [ "$FIXTURE_MODE" = "success" ]; then /usr/bin/touch "$FIXTURE_ACK"; fi\nexit 0\n', { mode: 0o700 });
  const source = await readFile(new URL("../../scripts/mac-update-helper.sh", import.meta.url), "utf8");
  const script = source.replaceAll("/usr/bin/open", '"' + launcher + '"').replaceAll("/bin/sleep 1", "/bin/sleep 0.01");
  const helper = path.join(root, "helper.sh"); await writeFile(helper, script);
  await exec("/bin/bash", [helper, pid, target, stage, backup, operation], { env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_ACK: path.join(operation, "ack") } }).catch(error => { if (error.code !== 1) throw error; });
}
it.skipIf(process.platform === "win32")("promotes a staged app only after quit and retains the previous app", async () => {
  await run("success");
  expect((await readFile(path.join(operation, "result"), "utf8")).trim()).toBe("success");
  expect(await readFile(path.join(target, "version"), "utf8")).toBe("new");
  expect(await readFile(path.join(backup, "version"), "utf8")).toBe("old");
});
it.skipIf(process.platform === "win32")("restores the old app when the new app fails its startup handshake", async () => {
  await run("failure");
  expect((await readFile(path.join(operation, "result"), "utf8")).trim()).toBe("failed");
  expect(await readFile(path.join(target, "version"), "utf8")).toBe("old");
  expect(await readFile(path.join(operation, "failed.app/version"), "utf8")).toBe("new");
});
it.skipIf(process.platform === "win32")("does not replace an app whose process is still running", async () => {
  await run("success", String(process.pid));
  expect((await readFile(path.join(operation, "result"), "utf8")).trim()).toBe("failed");
  expect(await readFile(path.join(target, "version"), "utf8")).toBe("old");
  await expect(access(backup)).rejects.toThrow();
});

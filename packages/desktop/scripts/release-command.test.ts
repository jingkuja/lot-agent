import { afterEach, beforeEach, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, copyFile } from "node:fs/promises";
import { generateKeyPairSync, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
// @ts-expect-error standalone build command is dependency-free JavaScript
import { createRelease, parseArgs } from "./release.mjs";
import { verifyManifest } from "../src/main/update-manifest.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "desktop-release-command-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyDir = path.join(root, ".lot-agent-release");
  await mkdir(keyDir);
  await writeFile(path.join(keyDir, "update-private.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  await writeFile(path.join(keyDir, "update-public.pem"), publicKey.export({ type: "spki", format: "pem" }));
  for (const file of ["packages/desktop/package.json", "deploy/desktop-release.mjs", "deploy/nginx-desktop-updates.conf", "deploy/nginx-desktop-downloads.conf", "docs/desktop-updates.md"]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await copyFile(path.resolve(file), path.join(root, file));
  }
  return { root, home: root, platform: "darwin", env: { npm_execpath: "/test/pnpm.cjs" } };
}

it("rejects invalid versions, duplicate options and unknown flags", () => {
  for (const args of [[], ["../1"], ["0.2.3-beta"], ["01.2.3"], ["0.2.3", "--force"], ["0.2.3", "--notes", "a", "--notes", "b"]]) {
    expect(() => parseArgs(args)).toThrow();
  }
  expect(parseArgs(["--help"])).toBeNull();
  expect(parseArgs(["0.2.3"]).version).toBe("0.2.3");
});

it("builds both targets with the requested version, signs all artifacts and archives public files only", async () => {
  const runtime = await fixture();
  const originalPackage = await readFile(path.join(root, "packages/desktop/package.json"), "utf8");
  const commands: string[][] = [];
  const run = async (command: string, args: string[], options: { env: Record<string, string>; cwd: string; stdio?: "ignore" }) => {
    if (command !== process.execPath) {
      const result = spawnSync(command, args, options);
      expect(result.status).toBe(0);
      return;
    }
    commands.push(args);
    expect(args).toContain("-c.extraMetadata.version=0.2.3");
    expect(args.slice(2, 4)).toEqual(["--publish", "never"]);
    expect(options.env.LOT_DESKTOP_UPDATE_URL).toBe("https://todoucloud.com/updates/stable/");
    expect(await readFile(options.env.LOT_DESKTOP_UPDATE_PUBLIC_KEY_FILE, "utf8")).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(options.env.LOT_DESKTOP_UPDATE_PRIVATE_KEY_FILE).toBeUndefined();
    const output = args.find(arg => arg.startsWith("-c.directories.output="))!.split("=").slice(1).join("=");
    await mkdir(output, { recursive: true });
    const targets = args[1] === "dist:desktop:mac" ? ["mac-arm64.zip", "mac-arm64.dmg", "mac-x64.zip", "mac-x64.dmg"] : ["win-x64.exe"];
    for (const target of targets) await writeFile(path.join(output, `linquclaw-0.2.3-${target}`), `installer-${target}`);
  };
  const result = await createRelease({ version: "0.2.3" }, { ...runtime, run });
  expect(commands.map(args => args[1])).toEqual(["dist:desktop:mac", "dist:desktop:win"]);
  expect(await readFile(path.join(root, "packages/desktop/package.json"), "utf8")).toBe(originalPackage);
  const publicPem = await readFile(path.join(result.bundle, "update-public.pem"), "utf8");
  for (const [folder, platform, arch] of [["mac-arm64", "darwin", "arm64"], ["mac-x64", "darwin", "x64"], ["win-x64", "win32", "x64"]] as const) {
    const manifest = verifyManifest(await readFile(path.join(result.bundle, "artifacts", folder, "latest.json"), "utf8"), publicPem, platform, arch);
    expect(manifest.version).toBe("0.2.3");
  }
  const archiveEntries = spawnSync("tar", ["-tzf", result.archive], { encoding: "utf8" });
  expect(archiveEntries.status).toBe(0);
  expect(archiveEntries.stdout).not.toContain("private.pem");
  expect(archiveEntries.stdout).toContain("desktop-release-0.2.3/publish-all.sh");
  expect(archiveEntries.stdout).toContain("desktop-release-0.2.3/desktop-updates.md");
  expect(archiveEntries.stdout).not.toMatch(/desktop-release-\d+\.\d+\.\d+\.md/);
  expect(await readFile(path.join(result.bundle, "README.zh-CN.md"), "utf8")).toContain("desktop-updates.md 的「首次配置 Nginx」");
  const sum = createHash("sha256").update(await readFile(result.archive)).digest("hex");
  expect(await readFile(`${result.archive}.sha256`, "utf8")).toBe(`${sum}  desktop-release-0.2.3.tar.gz\n`);
  expect(spawnSync("bash", ["-n", path.join(result.bundle, "publish-all.sh")]).status).toBe(0);
  expect((await stat(path.join(result.bundle, "publish-all.sh"))).mode & 0o111).not.toBe(0);
  expect(await readdir(path.join(root, "packages/desktop/release"))).toEqual(["0.2.3", "publish-0.2.3"]);
  await expect(createRelease({ version: "0.2.3" }, { ...runtime, run })).rejects.toThrow("already exists");
});

it("rejects mismatched keys before invoking the builder", async () => {
  const runtime = await fixture();
  const another = generateKeyPairSync("ed25519").publicKey;
  await writeFile(path.join(root, ".lot-agent-release/update-public.pem"), another.export({ type: "spki", format: "pem" }));
  await expect(createRelease({ version: "0.2.3" }, runtime)).rejects.toThrow("do not match");
  await expect(stat(path.join(root, "packages/desktop/release"))).rejects.toThrow();
});

it("cleans partial output and its lock after a failed build, preserving existing releases", async () => {
  const runtime = await fixture();
  const output = path.join(root, "packages/desktop/release");
  await mkdir(path.join(output, "publish-0.2.0"), { recursive: true });
  const run = async () => { throw new Error("packager failed"); };
  await expect(createRelease({ version: "0.2.3" }, { ...runtime, run })).rejects.toThrow("packager failed");
  expect(await readdir(output)).toEqual(["publish-0.2.0"]);
});

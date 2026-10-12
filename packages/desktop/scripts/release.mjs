#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { prepare } from "../../../deploy/desktop-release.mjs";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const defaultUrl = "https://todoucloud.com/updates/stable/";
const publishRoot = "/www/wwwroot/todoucloud.com/updates/stable";
const targets = [["mac", "arm64"], ["mac", "x64"], ["win", "x64"]];
const help = `Usage: pnpm release:desktop <major.minor.patch> [--notes file] [--electron-dist directory]
Run on macOS with Node.js 20+ and pnpm. Builds Mac ARM64/Intel and Windows x64,
signs manifests, and creates a server release archive. Does not upload or publish.
Defaults: https://todoucloud.com/updates/stable/, ~/.lot-agent-release/update-{private,public}.pem
Existing version directories are never overwritten. --notes accepts UTF-8 release notes.`;

export function parseArgs(argv) {
  const args = argv.filter(arg => arg !== "--");
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return null;
  const version = args.shift();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "") || !version.split(".").every(part => Number.isSafeInteger(Number(part)))) {
    throw new Error("Provide a stable version, for example: pnpm release:desktop 0.2.2");
  }
  const options = { version };
  for (let i = 0; i < args.length; i += 2) {
    const name = { "--notes": "notes", "--electron-dist": "electronDist" }[args[i]];
    if (!name || options[name] || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Invalid option: ${args[i]}`);
    options[name] = path.resolve(args[i + 1]);
  }
  return options;
}

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.signal ?? result.status})`);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function filesIn(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) result.push(...await filesIn(path.join(directory, entry.name), `${relative}/`));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Unexpected non-regular release file: ${relative}`);
  }
  return result.sort();
}

async function cachedElectron(desktopPackage, cacheRoot) {
  const version = desktopPackage.devDependencies.electron;
  const names = ["darwin-arm64", "darwin-x64", "win32-x64"].map(target => `electron-v${version}-${target}.zip`);
  const entries = await readdir(cacheRoot, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(cacheRoot, entry.name);
    if ((await Promise.all(names.map(name => exists(path.join(directory, name))))).every(Boolean)) return directory;
  }
  return null;
}

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
function publisher(version, url) {
  return [
    "#!/usr/bin/env bash", "set -euo pipefail", "umask 022",
    'release_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"',
    `publish_root="\${DESKTOP_PUBLISH_ROOT:-${publishRoot}}"`,
    'node -e \'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("Node.js 20+ is required"); process.exit(1); }\'',
    'mkdir -p "$publish_root"',
    "for target in mac-arm64 mac-x64 win-x64; do",
    '  node "$release_dir/desktop-release.mjs" publish \\',
    '    --source "$release_dir/artifacts/$target" \\',
    '    --root "$publish_root" \\',
    '    --public-key "$release_dir/update-public.pem" \\',
    `    --base-url ${shellQuote(url)}`,
    "done",
    `printf '%s\\n' 'Published all desktop ${version} channels.'`, "",
  ].join("\n");
}

function readme(version, url) {
  return `# Desktop ${version} 发布包

更新地址：${url}
包含 Mac ARM64 / Intel 的 ZIP、DMG，Windows x64 NSIS，Ed25519 签名清单和公钥。

将 desktop-release-${version}.tar.gz 上传到服务器 /tmp/，以发布目录管理员执行：

\`\`\`bash
install -d -m 700 /www/wwwroot/todoucloud.com/lot-agent-release /www/wwwroot/todoucloud.com/lot-agent-release/staging
tar --no-same-owner -xzf /tmp/desktop-release-${version}.tar.gz -C /www/wwwroot/todoucloud.com/lot-agent-release/staging
cd /www/wwwroot/todoucloud.com/lot-agent-release/staging/desktop-release-${version}
sha256sum -c SHA256SUMS
bash ./publish-all.sh
\`\`\`

要求服务器 Node.js 20+。沿用已经生效的 Nginx /updates/ 配置。
首次发布时先按 desktop-updates.md 的「首次配置 Nginx」配置 HTTPS 静态目录，再执行发布，成功后切换官网下载入口。
附带 nginx-updates.locations.conf 和 nginx-downloads.locations.conf，暂存目录应禁止公网访问。
发布脚本校验上传文件及公网完整下载，再逐平台切换清单，失败可原样重试。
正式文件目录：${publishRoot}；运行 publish-all.sh 不依赖当前工作目录。

发布后从更低版本客户端检查更新、等待下载、点击重启更新，并确认新版本为 ${version}。
密钥与安装身份沿用既有配置；包内没有私钥。Mac 无 Apple 代码签名，失败时可使用 DMG 手动安装。
完整流程见 desktop-updates.md。本机生成压缩包不会自动部署服务器。
`;
}

// The runner is injectable so tests can exercise failure cleanup and signed bundles
// without launching native packagers. Production always runs the real commands.
export async function createRelease(options, runtime = {}) {
  const root = runtime.root ?? projectRoot;
  const env = runtime.env ?? process.env;
  const execute = runtime.run ?? run;
  const home = runtime.home ?? os.homedir();
  if ((runtime.platform ?? process.platform) !== "darwin") throw new Error("Build all three targets on macOS; use dist:desktop:win for Windows-only builds.");
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Node.js 20+ is required");
  // Validate again for non-CLI callers, before constructing output paths.
  const { version } = parseArgs([options.version]);
  if (!env.npm_execpath) throw new Error("Run through pnpm release:desktop <version>");
  const desktop = path.join(root, "packages/desktop");
  const outputRoot = path.join(desktop, "release");
  const buildOutput = path.join(outputRoot, version);
  const releaseOutput = path.join(outputRoot, `publish-${version}`);
  for (const output of [buildOutput, releaseOutput]) {
    if (await exists(output)) throw new Error(`Release output already exists: ${output}. Use a new version; existing releases are not overwritten.`);
  }
  const keyFile = path.resolve(env.LOT_DESKTOP_UPDATE_PRIVATE_KEY_FILE ?? path.join(home, ".lot-agent-release/update-private.pem"));
  const publicFile = path.resolve(env.LOT_DESKTOP_UPDATE_PUBLIC_KEY_FILE ?? path.join(home, ".lot-agent-release/update-public.pem"));
  const privateKey = createPrivateKey(await readFile(keyFile));
  const publicKey = createPublicKey(await readFile(publicFile));
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") throw new Error("Release keys must be Ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  if (createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString() !== publicPem) throw new Error("Release public/private keys do not match");
  const url = new URL(env.LOT_DESKTOP_UPDATE_URL ?? defaultUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/?$/, "/") !== "/updates/stable/") {
    throw new Error("Update URL must be an HTTPS /updates/stable/ directory without credentials or query parameters");
  }
  url.pathname = "/updates/stable/";
  const notes = options.notes ? await readFile(options.notes, "utf8") : `${version}\n桌面客户端更新至 ${version}。\nDesktop client update to ${version}.\n`;
  if (notes.length > 16000) throw new Error("Release notes too large");
  const desktopPackage = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  const electronDist = options.electronDist ?? await cachedElectron(desktopPackage, path.join(home, "Library/Caches/electron"));
  if (electronDist && !(await lstat(electronDist)).isDirectory()) throw new Error("--electron-dist must be a directory");

  await mkdir(outputRoot, { recursive: true });
  const lock = path.join(outputRoot, ".desktop-release-lock");
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another release may be running. If an interrupted build left ${lock}, confirm no build is running before removing that lock.`);
    throw error;
  }
  let workspace;
  let movedBuild = false;
  let completed = false;
  try {
    // A different build could have completed while preflight was running.
    for (const output of [buildOutput, releaseOutput]) {
      if (await exists(output)) throw new Error(`Release output already exists: ${output}`);
    }
    workspace = await mkdtemp(path.join(outputRoot, `.release-${version}-`));
    const build = path.join(workspace, "build");
    const staging = path.join(workspace, "publish");
    const name = `desktop-release-${version}`;
    const bundle = path.join(staging, name);
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, "update-public.pem"), publicPem);
    await writeFile(path.join(bundle, "release-notes.txt"), notes);
    // Point the build at the normalized public-only file. Never pass private PEM
    // text to the builder or copy the private key into staging.
    const buildEnv = { ...env, LOT_DESKTOP_UPDATE_URL: url.href, LOT_DESKTOP_UPDATE_PUBLIC_KEY_FILE: path.join(bundle, "update-public.pem") };
    delete buildEnv.LOT_DESKTOP_UPDATE_PRIVATE_KEY_FILE;
    delete buildEnv.LOT_DESKTOP_UPDATE_PUBLIC_KEY;
    const builderOptions = ["--publish", "never", `-c.directories.output=${build}`, `-c.extraMetadata.version=${version}`];
    if (electronDist) builderOptions.push(`-c.electronDist=${electronDist}`);
    console.log(`Release ${version}: ${url.href}${electronDist ? " (using cached Electron)" : ""}`);
    for (const target of ["mac", "win"]) {
      await execute(process.execPath, [env.npm_execpath, `dist:desktop:${target}`, ...builderOptions], { cwd: root, env: buildEnv });
    }
    for (const [platform, arch] of targets) {
      await prepare({ version, platform, arch, input: build, output: path.join(bundle, "artifacts"), key: keyFile, notes: path.join(bundle, "release-notes.txt") });
    }
    for (const [source, destination] of [
      ["deploy/desktop-release.mjs", "desktop-release.mjs"],
      ["deploy/nginx-desktop-updates.conf", "nginx-updates.locations.conf"],
      ["deploy/nginx-desktop-downloads.conf", "nginx-downloads.locations.conf"],
      ["docs/desktop-updates.md", "desktop-updates.md"],
    ]) await copyFile(path.join(root, source), path.join(bundle, destination));
    await writeFile(path.join(bundle, "publish-all.sh"), publisher(version, url.href), { mode: 0o755 });
    await writeFile(path.join(bundle, "README.zh-CN.md"), readme(version, url.href));
    const sums = [];
    for (const file of await filesIn(bundle)) sums.push(`${await sha256(path.join(bundle, file))}  ${file}\n`);
    await writeFile(path.join(bundle, "SHA256SUMS"), sums.join(""));
    const archive = `${name}.tar.gz`;
    const archiveEnv = { ...env, COPYFILE_DISABLE: "1" };
    await execute("tar", ["--exclude=.DS_Store", "--exclude=._*", "-czf", path.join(staging, archive), "-C", staging, name], { cwd: root, env: archiveEnv });
    await execute("tar", ["-tzf", path.join(staging, archive)], { cwd: root, env: archiveEnv, stdio: "ignore" });
    await writeFile(path.join(staging, `${archive}.sha256`), `${await sha256(path.join(staging, archive))}  ${archive}\n`);
    await rename(build, buildOutput);
    movedBuild = true;
    await rename(staging, releaseOutput);
    completed = true;
    console.log(`Created ${path.join(releaseOutput, archive)}\nUpload this archive and run its publish-all.sh on the server.`);
    return { build: buildOutput, bundle: path.join(releaseOutput, name), archive: path.join(releaseOutput, archive) };
  } finally {
    if (!completed && movedBuild) await rename(buildOutput, path.join(workspace, "build"));
    if (workspace) await rm(workspace, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options) await createRelease(options);
    else console.log(help);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

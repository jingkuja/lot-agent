#!/usr/bin/env node
// Node 20+, no dependencies. Run `node deploy/desktop-release.mjs help`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";

const usage = `Desktop update publishing (Node 20+)
  keygen --private /secure/update-private.pem --public /secure/update-public.pem
  prepare --version 0.2.0 --platform mac|win --arch arm64|x64 --input packages/desktop/release --output /tmp/desktop-release --key /secure/update-private.pem [--notes notes.txt]
  publish --source /www/wwwroot/todoucloud.com/lot-agent-release/staging/mac-arm64 --root /www/wwwroot/todoucloud.com/updates/stable --public-key /secure/update-public.pem --base-url https://example.com/updates/stable/
Prepare on the build machine; copy the output platform folder to server staging;
publish on the server. Never put the private key on the download server.`;

function required(args, name) { if (!args[name]) throw new Error(`Missing --${name}`); return args[name]; }
function version(v) { if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v) || !v.split(".").map(Number).every(Number.isSafeInteger)) throw new Error("Expected stable semantic version"); return v; }
function target(platform, arch) {
  if (!((platform === "mac" && ["arm64", "x64"].includes(arch)) || (platform === "win" && arch === "x64"))) throw new Error("Unsupported platform/architecture");
  return `${platform}-${arch}`;
}
async function digest(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.size <= 0 || info.size > 2 * 1024 ** 3) throw new Error("Invalid artifact file");
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { size: info.size, sha512: hash.digest("base64") };
}
function decode(envelope, publicKey) {
  if (envelope.length > 128 * 1024) throw new Error("Manifest too large");
  const signed = JSON.parse(envelope);
  const payload = Buffer.from(signed.payload, "base64");
  if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, payload, publicKey, Buffer.from(signed.signature, "base64"))) throw new Error("Invalid signature");
  const m = JSON.parse(payload);
  version(m.version);
  if (m.schema !== 1 || !["darwin", "win32"].includes(m.platform) || typeof m.notes !== "string" || m.notes.length > 16000) throw new Error("Invalid manifest");
  const platform = m.platform === "darwin" ? "mac" : "win";
  target(platform, m.arch);
  const expected = platform === "mac" ? ["zip", "dmg"] : ["exe"];
  if (!m.artifacts || Object.keys(m.artifacts).some(ext => !expected.includes(ext))) throw new Error("Unexpected artifact type");
  for (const ext of platform === "mac" ? ["zip", "dmg"] : ["exe"]) {
    const a = m.artifacts?.[ext];
    if (!a || a.file !== `linquclaw-${m.version}-${platform}-${m.arch}.${ext}` || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > 2 * 1024 ** 3 || !/^[A-Za-z0-9+/]{86}==$/.test(a.sha512)) throw new Error("Invalid artifact");
  }
  return m;
}

export async function prepare(args) {
  const v = version(required(args, "version"));
  const platform = required(args, "platform"), arch = required(args, "arch");
  const folder = target(platform, arch);
  const key = createPrivateKey(await readFile(required(args, "key")));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected Ed25519 private key");
  const input = path.resolve(required(args, "input"));
  const output = path.join(path.resolve(required(args, "output")), folder);
  // A release must be prepared into a fresh directory. No mixed old artifacts.
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const artifacts = {};
  try {
    for (const ext of platform === "mac" ? ["zip", "dmg"] : ["exe"]) {
      const file = `linquclaw-${v}-${platform}-${arch}.${ext}`;
      await copyFile(path.join(input, file), path.join(output, file));
      artifacts[ext] = { file, ...await digest(path.join(output, file)) };
    }
    // Blockmaps are optional in v1 (full downloads); keep them for future use.
    for (const file of await readdir(input)) {
      if (Object.values(artifacts).some(a => `${a.file}.blockmap` === file)) await copyFile(path.join(input, file), path.join(output, file));
    }
    const notes = args.notes ? await readFile(args.notes, "utf8") : "";
    if (notes.length > 16000) throw new Error("Release notes too large");
    const payload = Buffer.from(JSON.stringify({ schema: 1, version: v, platform: platform === "mac" ? "darwin" : "win32", arch, notes, artifacts }));
    const envelope = JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, key).toString("base64") });
    decode(envelope, createPublicKey(key));
    await writeFile(path.join(output, "latest.json"), envelope);
    console.log(`Prepared ${folder} ${v}: ${output}`);
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}

async function verifyPublic(url, artifact) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30 * 60 * 1000) });
  const context = `URL: ${url}\nHTTP: ${response.status}; Content-Type: ${response.headers.get("content-type") ?? "unknown"}; Content-Length: ${response.headers.get("content-length") ?? "unknown"}\nExpected: ${artifact.size} bytes`;
  const hint = "Check the HTTPS /updates/ Nginx static root, SPA fallback/proxy rules, and CDN cache. Do not bypass checksum verification.";
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Public artifact unavailable\n${context}\n${hint}`);
  }
  if (/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body.cancel();
    throw new Error(`Public artifact returned HTML instead of an installer\n${context}\n${hint}`);
  }
  let size = 0;
  const hash = createHash("sha512");
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > artifact.size) throw new Error(`Public artifact too large\n${context}\nReceived at least: ${size} bytes\n${hint}`);
    hash.update(chunk);
  }
  const actualHash = hash.digest("base64");
  if (size !== artifact.size || actualHash !== artifact.sha512) {
    throw new Error(`Public artifact checksum mismatch\n${context}\nReceived: ${size} bytes\nExpected SHA-512: ${artifact.sha512}\nReceived SHA-512: ${actualHash}\n${hint}`);
  }
}

export async function publish(args) {
  const source = path.resolve(required(args, "source"));
  const key = createPublicKey(await readFile(required(args, "public-key")));
  const envelope = await readFile(path.join(source, "latest.json"), "utf8");
  const manifest = decode(envelope, key);
  const folder = target(manifest.platform === "darwin" ? "mac" : "win", manifest.arch);
  const root = path.resolve(required(args, "root"));
  const base = new URL(required(args, "base-url").replace(/\/?$/, "/"));
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Expected public HTTPS base URL");
  const destination = path.join(root, folder);
  await mkdir(destination, { recursive: true });
  const lock = path.join(destination, ".publish-lock");
  await mkdir(lock); // Concurrent publication fails before touching the channel.
  const temporary = await mkdtemp(path.join(destination, ".publish-"));
  try {
    const current = await readFile(path.join(destination, "latest.json"), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (current) {
      const previous = decode(current, key);
      const a = version(manifest.version).split(".").map(Number), b = version(previous.version).split(".").map(Number);
      const index = a.findIndex((part, i) => part !== b[i]);
      if (index < 0 ? current !== envelope : a[index] < b[index]) throw new Error("Release version must increase; identical releases may be retried");
    }
    for (const artifact of Object.values(manifest.artifacts)) {
      const sourceFile = path.join(source, artifact.file);
      const actual = await digest(sourceFile);
      if (actual.size !== artifact.size || actual.sha512 !== artifact.sha512) throw new Error("Staged artifact checksum mismatch");
      const temp = path.join(temporary, artifact.file);
      await copyFile(sourceFile, temp);
      await chmod(temp, 0o644);
      const copied = await digest(temp);
      if (copied.sha512 !== artifact.sha512 || copied.size !== artifact.size) throw new Error("Artifact changed during copy");
      try { await link(temp, path.join(destination, artifact.file)); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await digest(path.join(destination, artifact.file));
        if (existing.sha512 !== artifact.sha512 || existing.size !== artifact.size) throw new Error("Refusing to overwrite immutable artifact");
      }
      // Public verification is mandatory before publishing the pointer.
      await verifyPublic(new URL(`${folder}/${artifact.file}`, base), artifact);
    }
    // No unsigned YAML is consumed by either client. This single atomic file
    // binds version, platform, URLs and hashes to the release signing key.
    const pointer = path.join(temporary, "latest.json");
    await writeFile(pointer, envelope, { mode: 0o644 });
    await rename(pointer, path.join(destination, "latest.json"));
    const installer = manifest.platform === "darwin" ? manifest.artifacts.dmg : manifest.artifacts.exe;
    const alias = manifest.platform === "darwin" ? "download.dmg" : "download.exe";
    await symlink(installer.file, path.join(temporary, alias));
    await rename(path.join(temporary, alias), path.join(destination, alias));
    console.log(`Published ${folder} ${manifest.version}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Expected --name value");
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (command === "keygen") {
    const keys = generateKeyPairSync("ed25519");
    await writeFile(required(args, "private"), keys.privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
    await writeFile(required(args, "public"), keys.publicKey.export({ type: "spki", format: "pem" }), { flag: "wx", mode: 0o644 });
    console.log("Created update signing keys. Keep the private key off the web server and out of Git.");
  } else if (command === "prepare") await prepare(args);
  else if (command === "publish") await publish(args);
  else console.log(usage);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });

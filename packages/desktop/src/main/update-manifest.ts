import { createPublicKey, verify } from "node:crypto";

export interface UpdateArtifact { file: string; size: number; sha512: string }
export interface UpdateManifest {
  schema: 1;
  version: string;
  platform: "darwin" | "win32";
  arch: "arm64" | "x64";
  notes: string;
  artifacts: { zip?: UpdateArtifact; dmg?: UpdateArtifact; exe?: UpdateArtifact };
}

export function versionParts(value: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error("Invalid stable version");
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("Invalid version");
  return parts;
}

export function newerVersion(candidate: string, current: string): boolean {
  const a = versionParts(candidate), b = versionParts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function updateBase(raw: string, platform: string, arch: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Updates require a fixed HTTPS URL");
  if (!((platform === "darwin" && ["x64", "arm64"].includes(arch)) || (platform === "win32" && arch === "x64"))) throw new Error("Unsupported update platform");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${platform === "darwin" ? "mac" : "win"}-${arch}/`;
  return url;
}

/** Signature covers the exact bytes, including platform, paths and hashes. */
export function verifyManifest(envelope: string, publicKey: string, platform: string, arch: string): UpdateManifest {
  if (Buffer.byteLength(envelope) > 128 * 1024) throw new Error("Manifest too large");
  const signed = JSON.parse(envelope);
  if (typeof signed.payload !== "string" || typeof signed.signature !== "string") throw new Error("Invalid envelope");
  const key = createPublicKey(publicKey);
  const payload = Buffer.from(signed.payload, "base64");
  const signature = Buffer.from(signed.signature, "base64");
  if (key.asymmetricKeyType !== "ed25519" || signature.length !== 64 || !verify(null, payload, key, signature)) throw new Error("Invalid update signature");
  const m = JSON.parse(payload.toString("utf8")) as UpdateManifest;
  if (m.schema !== 1 || m.platform !== platform || m.arch !== arch || typeof m.notes !== "string" || m.notes.length > 16000) throw new Error("Invalid update target");
  versionParts(m.version);
  const required = platform === "darwin" ? ["zip", "dmg"] as const : ["exe"] as const;
  if (!m.artifacts || Object.keys(m.artifacts).some(ext => !(required as readonly string[]).includes(ext))) throw new Error("Unexpected artifact type");
  for (const ext of required) {
    const a = m.artifacts?.[ext];
    if (!a || typeof a.file !== "string" || !new RegExp(`^[a-zA-Z0-9][a-zA-Z0-9._-]*\\.${ext}$`).test(a.file) || !a.file.includes(`-${m.version}-`) ||
      !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > 2 * 1024 ** 3 || typeof a.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(a.sha512)) throw new Error("Invalid update artifact");
  }
  return m;
}

import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";

const exec = promisify(execFile);
let busy = false;

/** Preview is optional and bounded. The PPTX remains available on any converter failure. */
export async function renderPptPreview(buffer: Buffer, count: number, signal?: AbortSignal, fontDirectory?: string): Promise<Buffer[] | null> {
  signal?.throwIfAborted();
  if (process.env.PPT_PREVIEW === "0" || busy || count < 1 || count > 40 || buffer.byteLength > 30_000_000) return null;
  busy = true;
  let dir: string | undefined;
  try {
    // Do not let a template cause the office converter to load external resources
    // or active embedded content. Native chart workbooks are permitted.
    const zip = await JSZip.loadAsync(buffer);
    for (const file of Object.values(zip.files)) {
      if (/vba|activeX|oleObject/i.test(file.name)) return null;
      if (/embeddings\//.test(file.name) && !file.dir && !file.name.endsWith(".xlsx")) return null;
      if (file.name.endsWith(".rels") && /TargetMode\s*=\s*["']External["']/i.test(await file.async("string"))) return null;
    }
    dir = await mkdtemp(join(tmpdir(), "lot-ppt-preview-"));
    const pptx = join(dir, "deck.pptx");
    await writeFile(pptx, buffer);
    const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const fontConfig = join(dir, "fonts.conf");
    // Fontconfig-based headless builds may not discover host CJK fonts. Register
    // the repository's existing Noto face for this child process only.
    await writeFile(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>
      <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
      <dir>/usr/share/fonts</dir><dir>/usr/local/share/fonts</dir><dir>/System/Library/Fonts</dir>
      ${fontDirectory ? `<dir>${escapeXml(fontDirectory)}</dir>` : ""}
      <cachedir>${escapeXml(join(dir, "font-cache"))}</cachedir>
      <alias><family>Microsoft YaHei</family><prefer><family>Noto Sans SC</family><family>Noto Sans CJK SC</family></prefer></alias>
    </fontconfig>`);
    const env = { ...process.env, FONTCONFIG_FILE: fontConfig };
    const profile = pathToFileURL(join(dir, "profile")).href;
    await exec(process.env.PPT_SOFFICE_PATH || "soffice", [
      `-env:UserInstallation=${profile}`, "--headless", "--nologo", "--nodefault", "--norestore", "--convert-to", "pdf", "--outdir", dir, pptx,
    ], { timeout: 40_000, maxBuffer: 1_000_000, signal, env });
    await exec(process.env.PPT_PDFTOPPM_PATH || "pdftoppm", [
      "-png", "-scale-to", "1200", "-f", "1", "-l", String(count), join(dir, "deck.pdf"), join(dir, "slide"),
    ], { timeout: 20_000, maxBuffer: 1_000_000, signal, env });
    const files = (await readdir(dir)).filter(file => /^slide-\d+\.png$/.test(file)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    if (files.length !== count) return null;
    return await Promise.all(files.map(file => readFile(join(dir!, file))));
  } catch {
    signal?.throwIfAborted();
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    busy = false;
  }
}

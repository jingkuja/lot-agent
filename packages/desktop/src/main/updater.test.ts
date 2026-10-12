import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const mocks = vi.hoisted(() => ({
  directory: "", packaged: true, downloaded: "", provider: null as any, windows: null as any,
  fetchManifest: vi.fn(), downloadArtifact: vi.fn(), verifyArtifact: vi.fn(), prepareMacInstall: vi.fn(),
  openPath: vi.fn(), showItemInFolder: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getVersion: () => "0.2.0", getPath: () => mocks.directory, get isPackaged() { return mocks.packaged; } }, shell: { openPath: mocks.openPath, showItemInFolder: mocks.showItemInFolder } }));
vi.mock("./update-download.js", () => ({ fetchManifest: mocks.fetchManifest, downloadArtifact: mocks.downloadArtifact, verifyArtifact: mocks.verifyArtifact }));
vi.mock("./mac-update.js", () => ({ prepareMacInstall: mocks.prepareMacInstall, readMacInstall: async () => null }));
vi.mock("electron-updater", () => ({ default: {
  Provider: class {},
  NsisUpdater: class {
    listeners = new Map();
    quitAndInstall = vi.fn();
    constructor(options: any) { mocks.windows = this; mocks.provider = new options.updateProvider({}, this, {}); }
    on(name: string, callback: unknown) { this.listeners.set(name, callback); }
    async checkForUpdates() { return { isUpdateAvailable: true, cancellationToken: { cancel() {} } }; }
    async downloadUpdate() { return [mocks.downloaded]; }
  },
} }));
import { DesktopUpdater } from "./updater.js";
const platform = process.platform, architecture = process.arch;
let updater: DesktopUpdater;
const keys = generateKeyPairSync("ed25519");
function envelope(os = "darwin", arch = "arm64", version = "0.2.1") {
  const artifact = (ext: string) => ({ file: `linquclaw-${version}-${os === "darwin" ? "mac" : "win"}-${arch}.${ext}`, size: 1, sha512: createHash("sha512").update("x").digest("base64") });
  const payload = Buffer.from(JSON.stringify({ schema: 1, version, platform: os, arch, notes: "Fixes", artifacts: os === "darwin" ? { zip: artifact("zip"), dmg: artifact("dmg") } : { exe: artifact("exe") } }));
  return JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, keys.privateKey).toString("base64") });
}
function setup(os = "darwin", arch = "arm64") {
  Object.defineProperty(process, "platform", { value: os }); Object.defineProperty(process, "arch", { value: arch });
  const ctx = { getWindow: () => null, lockForInstall: vi.fn(() => true), unlockInstall: vi.fn(), quit: vi.fn(), beforeQuit: vi.fn() };
  updater = new DesktopUpdater(ctx);
  return ctx;
}
beforeEach(async () => {
  mocks.directory = await mkdtemp(path.join(tmpdir(), "desktop-updater-"));
  mocks.downloaded = path.join(mocks.directory, "installer.exe"); mocks.packaged = true;
  Object.defineProperty(process, "resourcesPath", { value: mocks.directory, configurable: true });
  vi.stubEnv("LOT_DESKTOP_UPDATE_URL", "https://updates.example/stable/");
  vi.stubEnv("LOT_DESKTOP_UPDATE_PUBLIC_KEY", keys.publicKey.export({ format: "pem", type: "spki" }).toString());
  mocks.fetchManifest.mockResolvedValue(envelope()); mocks.downloadArtifact.mockResolvedValue(undefined);
  mocks.verifyArtifact.mockResolvedValue(true); mocks.prepareMacInstall.mockResolvedValue({ operation: mocks.directory }); mocks.openPath.mockResolvedValue("");
});
afterEach(async () => {
  updater?.stop(); Object.defineProperty(process, "platform", { value: platform }); Object.defineProperty(process, "arch", { value: architecture });
  vi.unstubAllEnvs(); vi.resetAllMocks(); await rm(mocks.directory, { recursive: true, force: true });
});
it("checks and downloads automatically but installs only on request", async () => {
  const ctx = setup(); await updater.initialize();
  expect((await updater.check()).status).toBe("ready");
  expect(ctx.quit).not.toHaveBeenCalled();
  expect(mocks.fetchManifest.mock.calls[0][0].href).toBe("https://updates.example/stable/mac-arm64/latest.json");
  ctx.lockForInstall.mockReturnValue(false);
  expect((await updater.install()).blocked).toBe(true); expect(mocks.prepareMacInstall).not.toHaveBeenCalled();
  ctx.lockForInstall.mockReturnValue(true);
  expect((await updater.install()).status).toBe("installing"); expect(ctx.quit).toHaveBeenCalledOnce();
});
it("offers verified DMG fallback after replacement preparation fails", async () => {
  const ctx = setup(); await updater.initialize(); await updater.check();
  mocks.prepareMacInstall.mockRejectedValue(new Error("Read-only Applications directory"));
  expect((await updater.install()).status).toBe("error"); expect(ctx.unlockInstall).toHaveBeenCalledOnce(); expect(ctx.quit).not.toHaveBeenCalled();
  expect((await updater.manual()).status).toBe("manual");
  expect(mocks.downloadArtifact.mock.calls.at(-1)?.[1].file).toMatch(/\.dmg$/);
  expect(mocks.openPath).toHaveBeenCalledOnce();
});
it("deduplicates concurrent checks and never downloads unsigned input", async () => {
  setup(); await updater.initialize();
  let finish!: (value: string) => void;
  mocks.fetchManifest.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
  const first = updater.check(); await updater.check(); expect(mocks.fetchManifest).toHaveBeenCalledOnce();
  finish('{"version":"9.0.0"}'); expect((await first).status).toBe("error"); expect(mocks.downloadArtifact).not.toHaveBeenCalled();
});
it("rejects changed cached installers at install time", async () => {
  const ctx = setup(); await updater.initialize(); await updater.check(); mocks.verifyArtifact.mockResolvedValue(false);
  expect((await updater.install()).status).toBe("error"); expect(ctx.quit).not.toHaveBeenCalled(); expect(mocks.prepareMacInstall).not.toHaveBeenCalled();
});
it("does not download old versions or enable updates in development", async () => {
  setup(); await updater.initialize(); mocks.fetchManifest.mockResolvedValue(envelope("darwin", "arm64", "0.1.0"));
  expect((await updater.check()).status).toBe("current"); expect(mocks.downloadArtifact).not.toHaveBeenCalled();
  mocks.packaged = false; setup(); expect((await updater.check()).status).toBe("disabled");
});
it("feeds authenticated metadata to NSIS and disables install-on-quit", async () => {
  const ctx = setup("win32", "x64"); mocks.fetchManifest.mockResolvedValue(envelope("win32", "x64"));
  await updater.initialize(); expect((await updater.check()).status).toBe("ready");
  expect(mocks.windows.autoInstallOnAppQuit).toBe(false); expect(mocks.windows.allowDowngrade).toBe(false);
  expect((await mocks.provider.getLatestVersion()).version).toBe("0.2.1");
  expect(mocks.provider.resolveFiles()[0].url.href).toBe("https://updates.example/stable/win-x64/linquclaw-0.2.1-win-x64.exe");
  await updater.install(); expect(ctx.beforeQuit).toHaveBeenCalledOnce(); expect(mocks.windows.quitAndInstall).toHaveBeenCalledWith(false, true);
});

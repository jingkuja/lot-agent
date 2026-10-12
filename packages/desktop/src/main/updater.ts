import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { app, shell, type BrowserWindow } from "electron";
import type { NsisUpdater, UpdateInfo } from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import type { DesktopUpdateState } from "../../../web/src/types/desktop.js";
import { newerVersion, updateBase, verifyManifest, type UpdateManifest } from "./update-manifest.js";
import { downloadArtifact, fetchManifest, verifyArtifact } from "./update-download.js";
import { prepareMacInstall, readMacInstall } from "./mac-update.js";

interface Context {
  getWindow(): BrowserWindow | null;
  lockForInstall(): boolean;
  unlockInstall(): void;
  quit(): void;
  beforeQuit(): void;
}

export class DesktopUpdater {
  private state: DesktopUpdateState = { status: "disabled", currentVersion: app.getVersion(), progress: 0, manualAvailable: false };
  private readonly cache = path.join(app.getPath("userData"), "updates");
  private readonly publicKey = process.env.LOT_DESKTOP_UPDATE_PUBLIC_KEY ?? "";
  private readonly source = process.env.LOT_DESKTOP_UPDATE_URL ?? "";
  private base: URL | null = null;
  private manifest: UpdateManifest | null = null;
  private windows: NsisUpdater | null = null;
  private windowsFile: string | null = null;
  private busy = false;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private ctx: Context) {
    if (app.isPackaged && this.source && this.publicKey) {
      try { this.base = updateBase(this.source, process.platform, process.arch); this.state.status = "idle"; } catch { /* Fail closed. */ }
    }
  }
  getState(): DesktopUpdateState { return { ...this.state }; }
  private set(patch: Partial<DesktopUpdateState>) {
    this.state = { ...this.state, ...patch };
    this.ctx.getWindow()?.webContents.send("lot:update:state", this.getState());
  }
  private fail() { this.set({ status: "error", manualAvailable: !!this.manifest }); }
  private target() { return path.resolve(process.execPath, "../../.."); }

  /** Called before window creation so the independent helper can track startup. */
  async initialize() {
    if (!this.base) return;
    await mkdir(this.cache, { recursive: true, mode: 0o700 });
    if (process.platform === "darwin") {
      const install = await readMacInstall(this.cache, this.target());
      if (install?.version === app.getVersion()) {
        const result = await readFile(path.join(install.operation, "result"), "utf8").catch(() => "");
        if (result.trim() === "launching") await writeFile(path.join(install.operation, "new-pid"), String(process.pid), { mode: 0o600 });
      }
    }
  }
  async ready() {
    if (!this.base) return;
    if (process.platform === "darwin") {
      const install = await readMacInstall(this.cache, this.target());
      if (install) {
        const result = (await readFile(path.join(install.operation, "result"), "utf8").catch(() => "")).trim();
        if (install.version === app.getVersion() && result === "launching") {
          await writeFile(path.join(install.operation, "ack"), "ready", { mode: 0o600 });
        } else if (["failed", "recovery-required", "waiting", "launching"].includes(result)) {
          try {
            this.manifest = verifyManifest(await readFile(path.join(this.cache, "manifest.json"), "utf8"), this.publicKey, process.platform, process.arch);
            this.set({ version: this.manifest.version, notes: this.manifest.notes });
          } catch { /* A corrupt cache cannot authorize a download. */ }
          this.fail();
          // Preserve fallback on screen; do not immediately retry a failed install.
          this.schedule(6 * 60 * 60 * 1000);
          return;
        }
      }
    }
    this.schedule(30000 + Math.random() * 10000);
  }
  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.check().finally(() => this.schedule(6 * 60 * 60 * 1000 + Math.random() * 60000));
    }, ms);
    this.timer.unref();
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.controller?.abort(); }

  async check(): Promise<DesktopUpdateState> {
    if (!this.base || this.busy || this.state.status === "ready" || this.state.status === "installing") return this.getState();
    this.busy = true;
    this.controller = new AbortController();
    this.set({ status: "checking", progress: 0 });
    try {
      const envelope = await fetchManifest(new URL("latest.json", this.base), AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]));
      const manifest = verifyManifest(envelope, this.publicKey, process.platform, process.arch);
      if (!newerVersion(manifest.version, app.getVersion())) {
        this.manifest = null;
        this.set({ status: "current", version: undefined, notes: undefined, manualAvailable: false });
        return this.getState();
      }
      this.manifest = manifest;
      await writeFile(path.join(this.cache, "manifest.json"), envelope, { mode: 0o600 });
      this.set({ status: "downloading", version: manifest.version, notes: manifest.notes, manualAvailable: true });
      if (process.platform === "darwin") {
        await downloadArtifact(this.base, manifest.artifacts.zip!, path.join(this.cache, manifest.artifacts.zip!.file), AbortSignal.any([this.controller.signal, AbortSignal.timeout(30 * 60 * 1000)]), percent => this.set({ progress: percent }));
      } else await this.downloadWindows(manifest);
      this.set({ status: "ready", progress: 100 });
    } catch { this.fail(); }
    finally { this.busy = false; this.controller = null; }
    return this.getState();
  }

  private async downloadWindows(manifest: UpdateManifest) {
    const { default: updaterModule } = await import("electron-updater");
    const { NsisUpdater, Provider } = updaterModule;
    const base = this.base!;
    const artifact = manifest.artifacts.exe!;
    const info: UpdateInfo = { version: manifest.version, releaseDate: new Date(0).toISOString(), files: [{ url: artifact.file, size: artifact.size, sha512: artifact.sha512 }], path: artifact.file, sha512: artifact.sha512 };
    // The provider receives only the already verified manifest. It never reads
    // unsigned latest.yml, including during a concurrent server publication.
    class SignedProvider extends Provider<UpdateInfo> {
      constructor(_options: unknown, _updater: unknown, runtime: ProviderRuntimeOptions) { super(runtime); }
      async getLatestVersion() { return info; }
      resolveFiles() { return info.files.map(file => ({ url: new URL(file.url, base), info: file })); }
    }
    this.windows = new NsisUpdater({ provider: "custom", updateProvider: SignedProvider });
    this.windows.autoDownload = false;
    this.windows.autoInstallOnAppQuit = false;
    this.windows.allowDowngrade = false;
    this.windows.disableWebInstaller = true;
    this.windows.disableDifferentialDownload = true;
    this.windows.logger = null;
    this.windows.on("error", () => {
      if (this.state.status === "installing") this.ctx.unlockInstall();
      if (!this.controller?.signal.aborted) this.fail();
    });
    this.windows.on("download-progress", event => this.set({ progress: Math.floor(event.percent) }));
    const result = await this.windows.checkForUpdates();
    if (!result?.isUpdateAvailable) throw new Error("Update no longer available");
    const cancel = () => result.cancellationToken?.cancel();
    this.controller!.signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 30 * 60 * 1000);
    try {
      const files = await this.windows.downloadUpdate(result.cancellationToken);
      this.windowsFile = files[0];
      if (!this.windowsFile || !await verifyArtifact(this.windowsFile, artifact)) throw new Error("Installer verification failed");
    } finally { clearTimeout(timeout); this.controller!.signal.removeEventListener("abort", cancel); }
  }

  async install(): Promise<DesktopUpdateState> {
    if (this.busy || this.state.status !== "ready" || !this.manifest) return this.getState();
    if (!this.ctx.lockForInstall()) return { ...this.getState(), blocked: true };
    this.busy = true;
    this.set({ status: "installing" });
    try {
      if (process.platform === "darwin") {
        const artifact = this.manifest.artifacts.zip!;
        const zip = path.join(this.cache, artifact.file);
        if (!await verifyArtifact(zip, artifact)) throw new Error("Cached update changed");
        const install = await prepareMacInstall(zip, this.target(), this.manifest.version, this.cache, path.join(process.resourcesPath, "updater/mac-update-helper.sh"));
        // If some other quit handler prevents exit, the helper times out and
        // the still-running UI must leave "installing" and offer the DMG.
        let remaining = 75;
        const monitor = setInterval(() => {
          if (--remaining <= 0) {
            clearInterval(monitor); this.ctx.unlockInstall(); this.fail(); return;
          }
          void readFile(path.join(install.operation, "result"), "utf8").then(result => {
            if (["failed", "recovery-required"].includes(result.trim())) {
              clearInterval(monitor); this.ctx.unlockInstall(); this.fail();
            } else if (result.trim() === "success") clearInterval(monitor);
          }).catch(() => {});
        }, 1000);
        monitor.unref();
        this.ctx.quit();
      } else {
        if (!this.windows || !this.windowsFile || !await verifyArtifact(this.windowsFile, this.manifest.artifacts.exe!)) throw new Error("Cached installer changed");
        this.ctx.beforeQuit();
        this.windows.quitAndInstall(false, true);
      }
    } catch { this.ctx.unlockInstall(); this.fail(); }
    finally { this.busy = false; }
    return this.getState();
  }

  async manual(): Promise<DesktopUpdateState> {
    if (!this.manifest || !this.base || this.busy || this.state.status === "installing") return this.getState();
    this.busy = true;
    this.controller = new AbortController();
    try {
      const artifact = process.platform === "darwin" ? this.manifest.artifacts.dmg! : this.manifest.artifacts.exe!;
      const file = path.join(this.cache, artifact.file);
      this.set({ status: "downloading", progress: 0 });
      await downloadArtifact(this.base, artifact, file, AbortSignal.any([this.controller.signal, AbortSignal.timeout(30 * 60 * 1000)]), percent => this.set({ progress: percent }));
      if (process.platform === "darwin") {
        if (await shell.openPath(file)) throw new Error("Cannot open installer");
      } else shell.showItemInFolder(file);
      this.set({ status: "manual", progress: 100 });
    } catch { this.fail(); }
    finally { this.busy = false; this.controller = null; }
    return this.getState();
  }
}

import { lstat, readdir, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const COMIC_TEMP_ORPHAN_MAX_AGE_MS = 2 * 60 * 60_000;
export const COMIC_TEMP_CLEANUP_INTERVAL_MS = 60 * 60_000;
export const COMIC_RENDER_MIN_FREE_BYTES_DEFAULT = 1_073_741_824;

export type StatfsFn = typeof statfs;
export type DiskFreeSpaceResult = {
  ok: boolean;
  freeBytes: number;
  requiredBytes: number;
  path: string;
};

export type ComicTempCleanupResult = {
  scanned: number;
  removed: number;
  reclaimedBytes: number;
  skippedActive: number;
  errors: number;
};

const activeTempDirs = new Set<string>();

export function registerActiveComicTempDir(dirPath: string): void {
  activeTempDirs.add(resolve(dirPath));
}

export function unregisterActiveComicTempDir(dirPath: string): void {
  activeTempDirs.delete(resolve(dirPath));
}

export function isActiveComicTempDir(dirPath: string): boolean {
  return activeTempDirs.has(resolve(dirPath));
}

export function comicRenderMinFreeBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COMIC_RENDER_MIN_FREE_BYTES?.trim();
  if (!raw) return COMIC_RENDER_MIN_FREE_BYTES_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("COMIC_RENDER_MIN_FREE_BYTES must be a non-negative integer");
  }
  return parsed;
}

async function resolveStatfsPath(targetPath: string, statfsImpl: StatfsFn): Promise<{ path: string; stats: Awaited<ReturnType<StatfsFn>> }> {
  let current = resolve(targetPath);
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const stats = await statfsImpl(current);
      return { path: current, stats };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const parent = dirname(current);
      if (code === "ENOENT" && parent !== current) {
        current = parent;
        continue;
      }
      throw error;
    }
  }
  const stats = await statfsImpl(current);
  return { path: current, stats };
}

export async function readDiskFreeBytes(targetPath: string, statfsImpl: StatfsFn = statfs): Promise<number | null> {
  try {
    const { stats } = await resolveStatfsPath(targetPath, statfsImpl);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(freeBytes) && freeBytes >= 0 ? Math.floor(freeBytes) : null;
  } catch {
    return null;
  }
}

export async function checkDiskFreeSpace(
  targetPath: string,
  requiredBytes: number,
  statfsImpl: StatfsFn = statfs,
): Promise<DiskFreeSpaceResult> {
  const safeRequired = Math.max(0, Math.floor(requiredBytes));
  try {
    const { path, stats } = await resolveStatfsPath(targetPath, statfsImpl);
    const freeBytes = Math.max(0, Math.floor(Number(stats.bavail) * Number(stats.bsize)));
    return {
      ok: Number.isFinite(freeBytes) ? freeBytes >= safeRequired : true,
      freeBytes: Number.isFinite(freeBytes) ? freeBytes : -1,
      requiredBytes: safeRequired,
      path,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
      return { ok: true, freeBytes: -1, requiredBytes: safeRequired, path: resolve(targetPath) };
    }
    throw error;
  }
}

async function inspectDirTree(dirPath: string, depth = 0): Promise<{ bytes: number; latestMtimeMs: number }> {
  const info = await lstat(dirPath);
  let bytes = info.isFile() ? info.size : 0;
  let latestMtimeMs = info.mtimeMs;
  if (!info.isDirectory() || info.isSymbolicLink() || depth >= 4) {
    return { bytes, latestMtimeMs };
  }
  const entries = await readdir(dirPath).catch(() => []);
  for (const name of entries) {
    const child = await inspectDirTree(join(dirPath, name), depth + 1).catch(() => null);
    if (!child) continue;
    bytes += child.bytes;
    if (child.latestMtimeMs > latestMtimeMs) latestMtimeMs = child.latestMtimeMs;
  }
  return { bytes, latestMtimeMs };
}

async function sweepRoot(
  root: string,
  pattern: RegExp,
  maxAgeMs: number,
  nowMs: number,
  totals: ComicTempCleanupResult,
): Promise<void> {
  const names = await readdir(root).catch(() => []);
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const fullPath = resolve(root, name);
    totals.scanned += 1;
    if (activeTempDirs.has(fullPath)) {
      totals.skippedActive += 1;
      continue;
    }
    try {
      const top = await lstat(fullPath);
      if (top.isSymbolicLink() || !top.isDirectory()) continue;
      const { bytes, latestMtimeMs } = await inspectDirTree(fullPath);
      if (nowMs - latestMtimeMs < maxAgeMs) continue;
      await rm(fullPath, { recursive: true, force: true });
      totals.removed += 1;
      totals.reclaimedBytes += bytes;
    } catch {
      totals.errors += 1;
    }
  }
}

export async function cleanupComicOrphanTempDirs(options: {
  mediaRoot?: string;
  tempRoot?: string;
  maxAgeMs?: number;
  nowMs?: number;
} = {}): Promise<ComicTempCleanupResult> {
  const maxAgeMs = options.maxAgeMs ?? COMIC_TEMP_ORPHAN_MAX_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  const tempRoot = options.tempRoot ?? tmpdir();
  const totals: ComicTempCleanupResult = { scanned: 0, removed: 0, reclaimedBytes: 0, skippedActive: 0, errors: 0 };
  await sweepRoot(tempRoot, /^lot-comic-render-/, maxAgeMs, nowMs, totals);
  if (options.mediaRoot) {
    await sweepRoot(options.mediaRoot, /^\.(upload|frame|render)-/, maxAgeMs, nowMs, totals);
  }
  return totals;
}

export function startComicTempCleanup(options: {
  mediaRoot?: string;
  tempRoot?: string;
  maxAgeMs?: number;
  intervalMs?: number;
  purgeDeletedRenders?: () => Promise<void>;
} = {}): () => void {
  let running = false;
  const runSweep = async () => {
    if (running) return;
    running = true;
    try {
      const result = await cleanupComicOrphanTempDirs(options);
      if (result.removed > 0) {
        console.info("[comic-drama] cleaned orphan temporary directories", result);
      }
      await options.purgeDeletedRenders?.();
    } catch (error) {
      console.warn("[comic-drama] temporary directory cleanup failed", {
        errorType: error instanceof Error ? error.name : "Error",
      });
    } finally {
      running = false;
    }
  };
  void runSweep();
  const timer = setInterval(() => void runSweep(), options.intervalMs ?? COMIC_TEMP_CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

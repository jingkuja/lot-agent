import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { AnalysisError } from "./errors.js";

/** The parent only reads regular task-local files after its sandbox exits. */
export async function readAnalysisFile(directory: string, name: string, maxBytes: number): Promise<Buffer> {
  if (!/^(?:frame-\d{4}\.jpg|gray\.raw|speech\.wav)$/.test(name)) throw new AnalysisError("INVALID_PRIVATE_FILE");
  const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > maxBytes) throw new AnalysisError("INVALID_PRIVATE_FILE");
    return await handle.readFile();
  } finally { await handle.close(); }
}

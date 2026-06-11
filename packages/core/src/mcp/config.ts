import { readFile } from "node:fs/promises";
import type { MCPConfig } from "./client.js";

interface MCPConfigFile {
  servers: MCPConfig[];
}

export async function loadMCPConfig(filePath: string): Promise<MCPConfig[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as MCPConfigFile;
    return parsed.servers ?? [];
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

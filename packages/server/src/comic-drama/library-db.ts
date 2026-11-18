import type { Pool, PoolClient } from "pg";

export class ComicLibraryError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 413 | 415 | 503) { super(code); }
}

export function libraryMissing(): never { throw new ComicLibraryError("NOT_FOUND", 404); }

export async function libraryTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export type ComicQuery = Pick<PoolClient, "query">;

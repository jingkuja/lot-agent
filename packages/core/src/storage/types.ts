export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
}

export interface ObjectStorage {
  put(input: PutObjectInput): Promise<{ url: string }>;
  /**
   * Stream a body to storage without buffering it whole — the safe path for
   * large artifacts (e.g. multi-minute videos) that would otherwise blow up
   * memory. `sizeHint` lets backends that need a content length (some S3
   * uploads) size their request.
   */
  putStream(
    key: string,
    body: NodeJS.ReadableStream,
    contentType: string,
    sizeHint?: number
  ): Promise<{ url: string }>;
  /** Public URL for a key. On S3 with `expiresInSec` this returns a presigned URL. */
  getUrl(key: string, opts?: { expiresInSec?: number }): string;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

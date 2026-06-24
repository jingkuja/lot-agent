export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
}

export interface ObjectStorage {
  put(input: PutObjectInput): Promise<{ url: string }>;
  getUrl(key: string): string;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

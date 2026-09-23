export interface PrivateKnowledgeObject {
  key: string;
  sha256: string;
  size: number;
}

/** Private blobs have no getUrl. Authorization belongs to the server content route. */
export interface PrivateKnowledgeStorage {
  put(ownerId: string, body: NodeJS.ReadableStream, mime: string): Promise<PrivateKnowledgeObject>;
  open(key: string, range?: { start: number; end: number }): NodeJS.ReadableStream;
  size(key: string): Promise<number>;
}

/** Transport-independent knowledge contracts. No credentials or storage URLs. */
export type KnowledgeSourceType = "document" | "note" | "bookmark" | "image" | "audio" | "video" | "profile_fact";
export type KnowledgeOrigin = "extracted_text" | "manual_description" | "confirmed_fact" | "ocr" | "transcript" | "generated_description";
export type KnowledgePermission = "retrieval:read" | "profile:read" | "assets:read";
export type KnowledgeRetrievalMode = "keyword" | "semantic" | "hybrid";
export type KnowledgeStorageStatus = "uploading" | "stored" | "failed";
export type KnowledgeIndexStatus = "pending" | "processing" | "ready" | "failed" | "cancelled";

/** Omit citation when the parser has no genuine locator. DOCX has no page number. */
export type KnowledgeCitation =
  | { kind: "pdf"; page: number }
  | { kind: "text"; startLine: number; endLine: number }
  | { kind: "docx"; paragraph: number; heading?: string }
  | { kind: "media"; startSeconds: number; endSeconds?: number };

export interface KnowledgeCollection {
  id: string;
  name: string;
  description: string;
  storedCount: number;
  searchableCount: number;
}

/** Immutable profile: changing model/route/tokenizer requires a new index space. */
export interface KnowledgeIndexProfile {
  id: string;
  modelId: string;
  providerRoute: string;
  dimensions: number;
  distance: "cosine";
  normalized: boolean;
  chunkerVersion: string;
  tokenizerVersion: string;
  dictionaryVersion: string;
}

export interface KnowledgeRetrievalRequest {
  query: string;
  collectionIds: string[];
  topK: number;
  mode: KnowledgeRetrievalMode;
  sourceTypes: KnowledgeSourceType[];
  /** AND semantics; sourceTypes has OR semantics. */
  tags: string[];
  allowDegraded: boolean;
}

/** Constructed on the server after authenticating and checking every requested collection. */
export interface KnowledgeReadScope {
  readonly ownerId: string;
  readonly collectionIds: readonly string[];
  readonly callerKind: "session" | "internal" | "access_key";
  readonly permission: KnowledgePermission;
  readonly keyId?: string;
  readonly application?: string;
}

export interface KnowledgeEvidence {
  itemId: string;
  revisionId: string;
  chunkId: string;
  collectionIds: string[];
  title: string;
  content: string;
  sourceType: KnowledgeSourceType;
  origin: KnowledgeOrigin;
  score: { kind: "rrf" | "cosine" | "ts_rank_cd"; value: number };
  citation?: KnowledgeCitation;
}

export interface KnowledgeRetrievalResult {
  requestId: string;
  modeUsed: KnowledgeRetrievalMode;
  degraded: boolean;
  results: KnowledgeEvidence[];
  warnings: string[];
}

/** Local implementation belongs in server/knowledge; never calls the remote RAG as fallback. */
export interface KnowledgeService {
  listCollections(ownerId: string): Promise<KnowledgeCollection[]>;
  retrieve(scope: KnowledgeReadScope, request: KnowledgeRetrievalRequest): Promise<KnowledgeRetrievalResult>;
}

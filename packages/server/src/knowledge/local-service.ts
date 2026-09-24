import type { KnowledgeCollection, KnowledgeService } from "@lot-agent/core";
import type { DB } from "../db/database.js";
import { KnowledgeRepository, type KnowledgeCursor } from "./repository.js";
import { KnowledgeRetriever } from "./retrieval.js";
import { indexProfile } from "./ingestion/profile.js";
import { createUserEmbedder } from "./ingestion/runtime.js";
/** Direct in-process service; credentials remain bound to the collection owner. */
export function createLocalKnowledgeService(db: DB): KnowledgeService {
  const repository = new KnowledgeRepository(db.pool);
  const retriever = new KnowledgeRetriever(db.pool, indexProfile(process.env.OPENAI_BASE_URL ?? "https://tokenhub.wetok.ai/v1"), (owner, profile) => createUserEmbedder(db, profile, owner));
  return {
    async listCollections(ownerId) {
      const result: KnowledgeCollection[] = []; let cursor: KnowledgeCursor | undefined;
      do {
        const page = await repository.listCollections(ownerId, 100, cursor);
        result.push(...page.data); cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return result;
    },
    retrieve: (scope, request, signal) => retriever.retrieve(scope, request, signal),
  };
}

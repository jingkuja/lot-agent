import { createHash } from "node:crypto";
import { MarketingDraftSchema, newMarketingDraft } from "@lot-agent/core/marketing-video";
import type { Pool } from "pg";
import { PgMarketingProjectStore } from "./repository.js";

export interface EmployeeDraftInput {
  /** The same request always names the same draft, so a repeated tool call opens it again. */
  requestKey: string;
  topic: string;
  durationSec?: number;
  ratio?: "9:16" | "16:9" | "1:1";
}

/** Shaped as a UUID because the studio and the table expect one. */
function draftId(owner: string, requestKey: string): string {
  const hex = createHash("sha256").update(`${owner}\0${requestKey}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Only the brief is written: copy, storyboard, cost confirmation and submission stay in the studio. */
export function createEmployeeMarketingDrafts(pool: Pool, store = new PgMarketingProjectStore(pool)) {
  return {
    async create(owner: string, input: EmployeeDraftInput): Promise<{ projectId: string; reused: boolean }> {
      const id = draftId(owner, input.requestKey);
      if (await store.get(owner, id)) return { projectId: id, reused: true };
      const draft = MarketingDraftSchema.parse({
        ...newMarketingDraft(),
        topic: input.topic,
        ...(input.durationSec ? { durationSec: input.durationSec } : {}),
        ...(input.ratio ? { ratio: input.ratio } : {}),
      });
      await store.save(owner, id, 0, draft);
      return { projectId: id, reused: false };
    },
  };
}

import { expect, it } from "vitest";
import { KnowledgeKeyInputSchema } from "./access.js";
const id = "11111111-1111-4111-8111-111111111111";
it("defaults to retrieval only and rejects implicit/all grants and owner spoofing", () => {
  expect(KnowledgeKeyInputSchema.parse({ name: "bot", collectionIds: [id] }).scopes).toEqual(["retrieval:read"]);
  for (const body of [{ name: "bot", collectionIds: [] }, { name: "bot", collectionIds: [id, id] }, { name: "bot", collectionIds: [id], ownerId: id }]) expect(KnowledgeKeyInputSchema.safeParse(body).success).toBe(false);
});

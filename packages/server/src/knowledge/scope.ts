import { KnowledgeCollectionIdsSchema, type KnowledgePermission, type KnowledgeReadScope } from "@lot-agent/core";
import { KnowledgeError } from "./errors.js";

/** Only authentication middleware or server-owned task context may construct this.
 * External keys must be resolved afresh, including revocation, on every request.
 * Never cast HTTP bodies/headers to this type.
 */
export type VerifiedKnowledgeCaller =
  | { kind: "session"; userId: string; sessionId: string }
  | { kind: "internal"; userId: string; collectionIds: readonly string[] }
  | { kind: "access_key"; userId: string; keyId: string; application: string;
      scopes: readonly KnowledgePermission[]; collectionIds: readonly string[];
      expiresAt: string | null; revokedAt: string | null };

/** Repository must query by owner AND requested IDs; no cross-owner search then filtering. */
export type FindOwnedCollections = (ownerId: string, ids: readonly string[]) => Promise<readonly string[]>;

export async function resolveKnowledgeScope(
  caller: VerifiedKnowledgeCaller,
  requestedIds: readonly string[],
  permission: KnowledgePermission,
  findOwned: FindOwnedCollections,
  now = new Date(),
): Promise<KnowledgeReadScope> {
  if (!caller.userId) throw new KnowledgeError("UNAUTHORIZED", 401, "身份无效");
  if (caller.kind === "access_key") {
    const expiry = caller.expiresAt === null ? Infinity : Date.parse(caller.expiresAt);
    if (caller.revokedAt !== null || Number.isNaN(expiry) || expiry <= now.getTime()) {
      throw new KnowledgeError("UNAUTHORIZED", 401, "知识授权无效");
    }
    if (!caller.scopes.includes(permission)) throw new KnowledgeError("SCOPE_FORBIDDEN", 403, "知识授权范围不足");
  }
  const parsed = KnowledgeCollectionIdsSchema.safeParse(requestedIds);
  if (!parsed.success) throw new KnowledgeError("INVALID_REQUEST", 400, "请选择 1–10 个不同的知识库");
  const ids = parsed.data;
  if (caller.kind !== "session" && ids.some((id) => !caller.collectionIds.includes(id))) {
    throw new KnowledgeError("NOT_FOUND", 404, "知识库不存在或不可见");
  }
  const owned = new Set(await findOwned(caller.userId, ids));
  if (ids.some((id) => !owned.has(id))) throw new KnowledgeError("NOT_FOUND", 404, "知识库不存在或不可见");
  return Object.freeze({
    ownerId: caller.userId, collectionIds: Object.freeze([...ids]), callerKind: caller.kind, permission,
    ...(caller.kind === "access_key" ? { keyId: caller.keyId, application: caller.application } : {}),
  });
}

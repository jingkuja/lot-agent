import type { StoredUser } from "./database.js";

export interface PublicUser {
  id: string;
  name: string;
  username: string | null;
  apiKeys: string[];
  activeKeyIndex: number;
}

/** 中间遮罩：保留前 6、后 4，其余用 ***；过短(<=12)整体遮罩。 */
export function maskKey(key: string): string {
  return key.length <= 12 ? "***" : `${key.slice(0, 6)}***${key.slice(-4)}`;
}

/** Never send api_key/email to the client. Single choke point for user->client. */
export function toPublicUser(u: StoredUser): PublicUser {
  const keys = Array.isArray(u.api_keys) ? u.api_keys : [];
  return {
    id: u.id,
    name: u.name ?? u.username ?? "",
    username: u.username ?? null,
    apiKeys: keys.map(maskKey),
    activeKeyIndex: u.api_key ? keys.indexOf(u.api_key) : -1,
  };
}

import type { StoredUser } from "./database.js";
import { maskPhone } from "./phone.js";

export interface PublicApiKey {
  key: string;
  name: string;
  group?: string;
}

export interface PublicUser {
  id: string;
  name: string;
  username: string | null;
  phone: string | null;
  apiKeys: PublicApiKey[];
  activeKeyIndex: number;
}

/** 中间遮罩：保留前 6、后 4，其余用 ***；过短(<=12)整体遮罩。 */
export function maskKey(key: string): string {
  return key.length <= 12 ? "***" : `${key.slice(0, 6)}***${key.slice(-4)}`;
}

/** Never send api_key/email to the client. Single choke point for user->client. */
export function toPublicUser(u: StoredUser): PublicUser {
  // Lot Agent never exposes or selects user-owned API keys. All production
  // model calls use the server-held managed subscription credential.
  const phone = maskPhone(u.phone);
  return {
    id: u.id,
    name: u.name ?? u.username ?? "",
    username: u.username ?? null,
    phone,
    apiKeys: [],
    activeKeyIndex: -1,
  };
}

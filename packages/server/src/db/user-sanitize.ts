import type { StoredUser } from "./database.js";

export interface PublicUser {
  id: string;
  name: string;
  username: string | null;
}

/** Never send api_key/email to the client. Single choke point for user->client. */
export function toPublicUser(u: StoredUser): PublicUser {
  return { id: u.id, name: u.name ?? u.username ?? "", username: u.username ?? null };
}

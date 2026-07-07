export interface PublishInput {
  title: string;
  body: string;
  assetIds: string[];
  /** Topic/hashtags (platform-specific formatting handled by the connector). */
  tags?: string[];
  /** Asset id to use as the cover image. */
  coverAssetId?: string;
  /** ISO timestamp for scheduled publishing (server maps to a delayed job). */
  scheduleAt?: string;
  /** Dedup key so a retried publish does not post twice. */
  idempotencyKey?: string;
}

export interface TokenSet {
  accessToken: string;
  /** Present when the platform issues refreshable credentials. */
  refreshToken?: string;
  expiresAt: number;
}

export interface PlatformConnector {
  platform: string;
  getAuthUrl(userId: string): string;
  exchangeToken(code: string): Promise<TokenSet>;
  /** Exchange a refresh token for a fresh access token. */
  refreshToken(refreshToken: string): Promise<TokenSet>;
  /** Revoke a user's stored credentials for this platform. */
  revoke(userId: string): Promise<void>;
  publish(input: PublishInput): Promise<{ url: string }>;
}

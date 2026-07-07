import type { PlatformConnector, PublishInput, TokenSet } from "./types.js";

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

class StubConnector implements PlatformConnector {
  constructor(public readonly platform: string) {}

  getAuthUrl(userId: string): string {
    return `stub://oauth/${this.platform}?user=${encodeURIComponent(userId)}`;
  }

  async exchangeToken(code: string): Promise<TokenSet> {
    return {
      accessToken: `stub-token-${this.platform}-${code}`,
      refreshToken: `stub-refresh-${this.platform}-${code}`,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
  }

  async refreshToken(refreshToken: string): Promise<TokenSet> {
    return {
      accessToken: `stub-token-${this.platform}-${refreshToken}-refreshed`,
      refreshToken,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
  }

  async revoke(_userId: string): Promise<void> {
    // Stub: nothing to revoke. Real connectors call the platform's revoke endpoint.
  }

  async publish(input: PublishInput): Promise<{ url: string }> {
    const slug = encodeURIComponent(input.title.slice(0, 24) || "untitled");
    // scheduleAt/tags/coverAssetId/idempotencyKey are accepted here; a real
    // connector would honor them (server maps scheduleAt → a delayed job).
    return { url: `stub://published/${this.platform}/${slug}` };
  }
}

export class XiaohongshuConnector extends StubConnector { constructor() { super("xiaohongshu"); } }
export class WechatMpConnector extends StubConnector { constructor() { super("wechat_mp"); } }

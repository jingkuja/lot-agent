import type { PlatformConnector, PublishInput } from "./types.js";

class StubConnector implements PlatformConnector {
  constructor(public readonly platform: string) {}
  getAuthUrl(userId: string): string {
    return `stub://oauth/${this.platform}?user=${encodeURIComponent(userId)}`;
  }
  async exchangeToken(code: string): Promise<{ accessToken: string; expiresAt: number }> {
    return { accessToken: `stub-token-${this.platform}-${code}`, expiresAt: Date.now() + 7 * 24 * 3600 * 1000 };
  }
  async publish(input: PublishInput): Promise<{ url: string }> {
    const slug = encodeURIComponent(input.title.slice(0, 24) || "untitled");
    return { url: `stub://published/${this.platform}/${slug}` };
  }
}

export class XiaohongshuConnector extends StubConnector { constructor() { super("xiaohongshu"); } }
export class WechatMpConnector extends StubConnector { constructor() { super("wechat_mp"); } }

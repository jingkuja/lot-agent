export interface PublishInput { title: string; body: string; assetIds: string[]; }
export interface PlatformConnector {
  platform: string;
  getAuthUrl(userId: string): string;
  exchangeToken(code: string): Promise<{ accessToken: string; expiresAt: number }>;
  publish(input: PublishInput): Promise<{ url: string }>;
}

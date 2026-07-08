import { normalizeApiKeyEntries, type RawApiKeyEntry } from "./api-key-entry.js";

export interface TokenhubLoginResult {
  userId: number;
  name: string;
  apiKeys: RawApiKeyEntry[];
}
export interface TokenhubModels {
  llm: string[];
  image: string[];
  video: string[];
}

interface Envelope<T> {
  data: T | null;
  success: boolean;
  message?: string;
}

/** Thin fetch wrapper over tokenhub's agent-market API. Every failure — network,
 * non-2xx, or `success:false` — is collapsed into a single generic Error so
 * callers cannot leak the underlying cause to end users. */
export class TokenhubClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async login(username: string, password: string): Promise<TokenhubLoginResult> {
    const data = await this.post<{
      user_id: number;
      name: string;
      api_key?: string;
      api_keys?: unknown[];
    }>("/auth/login", { username, password }, "tokenhub_login_failed");
    const apiKeys = normalizeApiKeyEntries(data.api_keys ?? (data.api_key ? [data.api_key] : []));
    return { userId: data.user_id, name: data.name, apiKeys };
  }

  async listModels(apiKey: string): Promise<TokenhubModels> {
    const data = await this.get<Partial<TokenhubModels>>(
      "/models",
      apiKey,
      "tokenhub_models_failed"
    );
    return { llm: data.llm ?? [], image: data.image ?? [], video: data.video ?? [] };
  }

  private async post<T>(path: string, body: unknown, errCode: string): Promise<T> {
    return this.unwrap<T>(
      () =>
        this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      errCode
    );
  }

  private async get<T>(path: string, apiKey: string, errCode: string): Promise<T> {
    return this.unwrap<T>(
      () =>
        this.fetchImpl(`${this.baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        }),
      errCode
    );
  }

  private async unwrap<T>(call: () => Promise<Response>, errCode: string): Promise<T> {
    try {
      const res = await call();
      if (!res.ok) throw new Error(errCode);
      const env = (await res.json()) as Envelope<T>;
      if (!env.success || env.data == null) throw new Error(errCode);
      return env.data;
    } catch {
      throw new Error(errCode);
    }
  }
}

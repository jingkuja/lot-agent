import { logger } from "@lot-agent/core";
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
    private readonly fetchImpl: typeof fetch = fetch,
    /** Shared secret proving this Agent (compute box) to new-api on token-login.
     * Sent as a Bearer header; missing/wrong key → 403 invalid agent key. */
    private readonly agentKey: string = ""
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

  async tokenLogin(token: string): Promise<TokenhubLoginResult> {
    const data = await this.post<{
      user_id: number;
      name: string;
      api_key?: string;
      api_keys?: unknown[];
    }>(
      "/auth/token-login",
      { token },
      "tokenhub_token_login_failed",
      this.agentKey ? { Authorization: `Bearer ${this.agentKey}` } : undefined
    );
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

  private async post<T>(
    path: string,
    body: unknown,
    errCode: string,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    return this.unwrap<T>(
      () =>
        this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...extraHeaders },
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
    // Client-facing responses stay opaque (a single generic error), but the real
    // cause — HTTP status + upstream message (e.g. 403 "invalid agent key") — is
    // logged server-side so operators can diagnose. Never logs the token/api key.
    let res: Response;
    try {
      res = await call();
    } catch (err) {
      logger.warn("tokenhub request failed", { errCode, cause: "network", err });
      throw new Error(errCode);
    }
    let env: Envelope<T> | null = null;
    try {
      env = (await res.json()) as Envelope<T>;
    } catch {
      // non-JSON / empty body — env stays null; still reported via status below.
    }
    if (!res.ok || !env || !env.success || env.data == null) {
      logger.warn("tokenhub request failed", {
        errCode,
        status: res.status,
        message: env?.message,
      });
      throw new Error(errCode);
    }
    return env.data;
  }
}

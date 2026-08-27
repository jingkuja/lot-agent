import { logger } from "@lot-agent/core";
import { createHash, createHmac, randomUUID } from "node:crypto";
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

export interface ManagedKeyCredential {
  tokenId: number;
  apiKey: string;
  credentialVersion: number;
  remainQuota: number;
}

export interface ManagedUserResult {
  userId: number;
  username: string;
  name: string;
  email?: string;
  phone?: string;
  managedKey: ManagedKeyCredential;
  created: boolean;
}

export interface ManagedBalanceResult {
  userId: number;
  tokenId: number;
  remainAmount: number;
  usedAmount: number;
  rechargedAmount: number;
  status: string;
  credentialVersion: number;
  policyRevision: number;
}

export interface ManagedRechargeOrder {
  transactionId: string;
  status: "pending" | "payment_failed" | "credited";
  amount?: number;
  points?: number;
  quota?: number;
  currency?: string;
  orderSource?: string;
  paymentMethod?: string;
  paymentKind?: "qrcode" | "redirect";
  codeUrl?: string;
  payUrl?: string;
}

export interface ManagedRechargeInfo {
  enabled: boolean;
  paymentMethods: Array<{ name: string; type: string }>;
  amountDiscount: Record<string, number>;
}

interface Envelope<T> {
  data: T | null;
  success: boolean;
  message?: string;
  code?: string;
}

export class TokenhubClientError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "TokenhubClientError";
  }
}

/** Thin fetch wrapper over tokenhub's agent-market API. Error messages stay
 * generic; signed internal calls may also carry a structured code that routes
 * explicitly translate from a small safe allowlist. */
export class TokenhubClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Shared secret proving this Agent (compute box) to new-api on token-login.
     * Sent as a Bearer header; missing/wrong key → 403 invalid agent key. */
    private readonly agentKey: string = "",
    private readonly internalBaseUrl: string = deriveInternalBaseUrl(baseUrl),
    private readonly internalClientId: string = process.env.NEW_API_INTERNAL_CLIENT_ID ?? "",
    private readonly internalClientSecret: string = process.env.NEW_API_INTERNAL_CLIENT_SECRET ?? ""
  ) {}

  async registerAgentUser(args: {
    requestId: string;
    username: string;
    password: string;
    email?: string;
    emailVerificationCode?: string;
    phone?: string;
    phoneVerificationCode?: string;
    displayName?: string;
  }): Promise<ManagedUserResult> {
    const data = await this.internalRequest<ManagedUserWire>(
      "POST",
      "/agent-users/register",
      {
        owner_app: "lot-agent",
        username: args.username,
        password: args.password,
        email: args.email ?? "",
        email_verification_code: args.emailVerificationCode ?? "",
        phone: args.phone ?? "",
        phone_verification_code: args.phoneVerificationCode ?? "",
        display_name: args.displayName ?? "",
      },
      "agent:user.register",
      "new_api_managed_register_failed",
      { "Idempotency-Key": args.requestId }
    );
    return mapManagedUser(data);
  }

  async sendAgentEmailVerification(email: string): Promise<{ expiresIn: number; resendAfter: number }> {
    const data = await this.internalRequest<{ expires_in: number; resend_after: number }>(
      "POST",
      "/agent-users/verification/email",
      { owner_app: "lot-agent", email },
      "agent:user.register",
      "new_api_email_verification_failed"
    );
    return { expiresIn: data.expires_in, resendAfter: data.resend_after };
  }

  async sendAgentPasswordResetEmail(
    email: string,
    resetUrl: string
  ): Promise<{ expiresIn: number; resendAfter: number }> {
    const data = await this.internalRequest<{ expires_in: number; resend_after: number }>(
      "POST",
      "/agent-users/password-reset",
      { owner_app: "lot-agent", email, reset_url: resetUrl },
      "agent:user.authenticate",
      "new_api_password_reset_send_failed"
    );
    return { expiresIn: data.expires_in, resendAfter: data.resend_after };
  }

  async resetAgentPassword(args: {
    email: string;
    token: string;
    password: string;
    confirmPassword: string;
  }): Promise<void> {
    await this.internalRequest<true>(
      "POST",
      "/agent-users/password-reset/confirm",
      {
        owner_app: "lot-agent",
        email: args.email,
        token: args.token,
        password: args.password,
        confirm_password: args.confirmPassword,
      },
      "agent:user.authenticate",
      "new_api_password_reset_confirm_failed"
    );
  }

  async sendAgentPhoneVerification(
    phone: string,
    purpose: "register" | "login"
  ): Promise<{ expiresIn: number; resendAfter: number }> {
    const data = await this.internalRequest<{ expires_in: number; resend_after: number }>(
      "POST",
      `/agent-users/verification/phone/${purpose}`,
      { owner_app: "lot-agent", phone },
      purpose === "login" ? "agent:user.authenticate" : "agent:user.register",
      "new_api_phone_verification_failed"
    );
    return { expiresIn: data.expires_in, resendAfter: data.resend_after };
  }

  async authenticateAgentUser(username: string, password: string): Promise<ManagedUserResult> {
    const data = await this.internalRequest<ManagedUserWire>(
      "POST",
      "/agent-users/authenticate",
      { owner_app: "lot-agent", username, password },
      "agent:user.authenticate",
      "new_api_managed_auth_failed"
    );
    return mapManagedUser(data);
  }

  async authenticateAgentUserByPhone(phone: string, verificationCode: string): Promise<ManagedUserResult> {
    const data = await this.internalRequest<ManagedUserWire>(
      "POST",
      "/agent-users/authenticate-phone",
      { owner_app: "lot-agent", phone, verification_code: verificationCode },
      "agent:user.authenticate",
      "new_api_managed_phone_auth_failed"
    );
    return mapManagedUser(data);
  }

  async sendAgentPhoneBindingVerification(
    userId: number,
    phone: string
  ): Promise<{ expiresIn: number; resendAfter: number }> {
    const data = await this.internalRequest<{ expires_in: number; resend_after: number }>(
      "POST",
      "/agent-users/verification/phone/bind",
      { owner_app: "lot-agent", user_id: userId, phone },
      "agent:user.authenticate",
      "new_api_phone_binding_verification_failed"
    );
    return { expiresIn: data.expires_in, resendAfter: data.resend_after };
  }

  async bindAgentPhone(userId: number, phone: string, verificationCode: string): Promise<{ phone: string }> {
    const data = await this.internalRequest<{ phone: string }>(
      "POST",
      "/agent-users/bind-phone",
      { owner_app: "lot-agent", user_id: userId, phone, verification_code: verificationCode },
      "agent:user.authenticate",
      "new_api_phone_binding_failed"
    );
    return { phone: data.phone };
  }

  async ensureManagedKey(userId: number): Promise<ManagedUserResult> {
    const data = await this.internalRequest<ManagedUserWire>(
      "POST",
      "/agent-managed-keys/ensure",
      { owner_app: "lot-agent", user_id: userId },
      "agent:key.ensure",
      "new_api_managed_ensure_failed"
    );
    return mapManagedUser(data);
  }

  async creditManagedKey(args: {
    userId: number;
    transactionId: string;
    quotaDelta: number;
    paidAmount?: string;
    currency?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ transactionId: string; tokenId: number; remainQuota: number; duplicate: boolean }> {
    const data = await this.internalRequest<{
      transaction_id: string;
      token_id: number;
      remain_quota: number;
      duplicate: boolean;
    }>(
      "POST",
      "/agent-managed-keys/credit",
      {
        owner_app: "lot-agent",
        user_id: args.userId,
        transaction_id: args.transactionId,
        quota_delta: args.quotaDelta,
        paid_amount: args.paidAmount ?? "",
        currency: args.currency ?? "CNY",
        metadata: args.metadata ?? {},
      },
      "agent:key.credit",
      "new_api_managed_credit_failed",
      { "Idempotency-Key": args.transactionId }
    );
    return {
      transactionId: data.transaction_id,
      tokenId: data.token_id,
      remainQuota: data.remain_quota,
      duplicate: data.duplicate,
    };
  }

  async getManagedBalance(userId: number): Promise<ManagedBalanceResult> {
    const data = await this.internalRequest<{
      user_id: number;
      token_id: number;
      remain_quota: number;
      used_quota: number;
      remain_amount: number;
      used_amount: number;
      recharged_amount: number;
      status: string;
      credential_version: number;
      policy_revision: number;
    }>(
      "GET",
      `/agent-managed-keys/${userId}/balance?owner_app=lot-agent`,
      undefined,
      "agent:key.balance",
      "new_api_managed_balance_failed"
    );
    return {
      userId: data.user_id,
      tokenId: data.token_id,
      remainAmount: data.remain_amount,
      usedAmount: data.used_amount,
      rechargedAmount: data.recharged_amount,
      status: data.status,
      credentialVersion: data.credential_version,
      policyRevision: data.policy_revision,
    };
  }

  async createManagedRechargeOrder(args: {
    userId: number;
    points: number;
    paymentMethod: string;
  }): Promise<ManagedRechargeOrder> {
    const data = await this.internalRequest<{
      transaction_id: string;
      status: string;
      amount?: number;
      points?: number;
      currency?: string;
      order_source?: string;
      payment_method?: string;
      payment_kind?: string;
      code_url?: string;
      pay_url?: string;
    }>(
      "POST",
      "/agent-managed-recharge/orders",
      {
        owner_app: "lot-agent",
        user_id: args.userId,
        points: args.points,
        payment_method: args.paymentMethod,
      },
      "agent:recharge.create",
      "new_api_managed_recharge_create_failed"
    );
    return mapManagedRechargeOrder(data);
  }

  async getManagedRechargeInfo(userId: number): Promise<ManagedRechargeInfo> {
    const data = await this.internalRequest<{
      enabled: boolean;
      pay_methods?: Array<Record<string, string>>;
      amount_discount?: unknown;
    }>(
      "GET",
      `/agent-managed-recharge/info?owner_app=lot-agent&user_id=${userId}`,
      undefined,
      "agent:recharge.read",
      "new_api_managed_recharge_info_failed"
    );
    return {
      enabled: data.enabled,
      paymentMethods: (data.pay_methods ?? []).flatMap((method) => {
        const name = method.name?.trim();
        const type = method.type?.trim();
        return name && type ? [{ name, type }] : [];
      }),
      amountDiscount: normalizeManagedRechargeDiscount(data.amount_discount),
    };
  }

  async getManagedRechargeOrder(userId: number, transactionId: string): Promise<ManagedRechargeOrder> {
    const data = await this.internalRequest<{
      transaction_id: string;
      status: string;
      amount?: number;
      points?: number;
      quota?: number;
      currency?: string;
      order_source?: string;
      payment_method?: string;
    }>(
      "GET",
      `/agent-managed-recharge/orders/${encodeURIComponent(transactionId)}?owner_app=lot-agent&user_id=${userId}`,
      undefined,
      "agent:recharge.read",
      "new_api_managed_recharge_status_failed"
    );
    return mapManagedRechargeOrder(data);
  }

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

  private async internalRequest<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    scope: string,
    errCode: string,
    extraHeaders: Record<string, string> = {}
  ): Promise<T> {
    if (!this.internalClientId || !this.internalClientSecret) {
      logger.warn("new-api internal client is not configured", { errCode, scope });
      throw new TokenhubClientError(errCode);
    }
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const bodyHash = createHash("sha256").update(bodyText).digest("hex");
    const requestUrl = new URL(`${this.internalBaseUrl.replace(/\/$/, "")}${path}`);
    const signedRequestUri = `${requestUrl.pathname}${requestUrl.search}`;
    const canonical = `${method}\n${signedRequestUri}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const signature = createHmac("sha256", this.internalClientSecret).update(canonical).digest("hex");
    return this.unwrap<T>(
      () => this.fetchImpl(requestUrl.toString(), {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          "X-Internal-Client-Id": this.internalClientId,
          "X-Internal-Timestamp": timestamp,
          "X-Internal-Nonce": nonce,
          "X-Internal-Signature": signature,
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: bodyText }),
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
      throw new TokenhubClientError(errCode);
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
      throw new TokenhubClientError(errCode, env?.code);
    }
    return env.data;
  }
}

interface ManagedUserWire {
  user_id: number;
  username: string;
  display_name: string;
  email?: string;
  phone?: string;
  managed_key: {
    token_id: number;
    api_key: string;
    credential_version: number;
    remain_quota: number;
  };
  created: boolean;
}

function mapManagedUser(data: ManagedUserWire): ManagedUserResult {
  return {
    userId: data.user_id,
    username: data.username,
    name: data.display_name || data.username,
    email: typeof data.email === "string" ? data.email.trim() || undefined : undefined,
    phone: typeof data.phone === "string" ? data.phone.trim() || undefined : undefined,
    managedKey: {
      tokenId: data.managed_key.token_id,
      apiKey: data.managed_key.api_key,
      credentialVersion: data.managed_key.credential_version,
      remainQuota: data.managed_key.remain_quota,
    },
    created: data.created,
  };
}

function mapManagedRechargeOrder(data: {
  transaction_id: string;
  status: string;
  amount?: number;
  points?: number;
  quota?: number;
  currency?: string;
  order_source?: string;
  payment_method?: string;
  payment_kind?: string;
  code_url?: string;
  pay_url?: string;
}): ManagedRechargeOrder {
  return {
    transactionId: data.transaction_id,
    status: data.status === "success"
      ? "credited"
      : data.status === "failed" || data.status === "expired" ? "payment_failed" : "pending",
    amount: data.amount,
    points: data.points,
    quota: data.quota,
    currency: data.currency,
    orderSource: data.order_source,
    paymentMethod: data.payment_method,
    paymentKind: data.payment_kind === "qrcode" || data.payment_kind === "redirect" ? data.payment_kind : undefined,
    codeUrl: data.code_url,
    payUrl: data.pay_url,
  };
}

function normalizeManagedRechargeDiscount(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, number> = {};
  for (const [rawThreshold, rawDiscount] of Object.entries(value)) {
    const threshold = Number(rawThreshold);
    if (!Number.isSafeInteger(threshold) || threshold <= 0) continue;
    if (typeof rawDiscount !== "number" || !Number.isFinite(rawDiscount) || rawDiscount <= 0 || rawDiscount > 1) continue;
    normalized[String(threshold)] = rawDiscount;
  }
  return normalized;
}

function deriveInternalBaseUrl(agentMarketBaseUrl: string): string {
  return agentMarketBaseUrl.replace(/\/$/, "").replace(/\/api\/agent-market$/, "/api/internal");
}

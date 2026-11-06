import { describe, it, expect } from "vitest";
import { formatLLMError, isUnauthorizedLLMError, LLM_QUOTA_HINT, isQuotaError, llmErrorCode } from "./errors.js";

describe("isUnauthorizedLLMError", () => {
  it("matches status 401 on the error object", () => {
    expect(isUnauthorizedLLMError({ status: 401, message: "nope" })).toBe(true);
    expect(isUnauthorizedLLMError({ statusCode: 401 })).toBe(true);
  });

  it("matches a 401 in the message (newpai 无效的令牌 shape)", () => {
    expect(isUnauthorizedLLMError(new Error("401 无效的令牌 (request id: abc)"))).toBe(true);
  });

  it("does not match other HTTP errors", () => {
    expect(isUnauthorizedLLMError(new Error("upstream 500"))).toBe(false);
    expect(isUnauthorizedLLMError({ status: 403 })).toBe(false);
    expect(isUnauthorizedLLMError(new Error("rate limited"))).toBe(false);
  });
});

describe("isQuotaError", () => {
  it("recognises a 402 under any of the status fields", () => {
    expect(isQuotaError({ status: 402 })).toBe(true);
    expect(isQuotaError({ statusCode: 402 })).toBe(true);
    expect(isQuotaError({ httpStatus: 402 })).toBe(true);
  });

  it("recognises the gateway's codes, nested or not", () => {
    expect(isQuotaError({ status: 403, code: "insufficient_balance" })).toBe(true);
    expect(isQuotaError({ status: 401, error: { code: "insufficient_quota" } })).toBe(true);
  });

  it("does not call a plain 401 or 500 a quota error", () => {
    expect(isQuotaError({ status: 401 })).toBe(false);
    expect(isQuotaError({ status: 500, code: "server_error" })).toBe(false);
    expect(isQuotaError(new Error("x"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});

describe("llmErrorCode", () => {
  it("counts a plain 401, because that is how an exhausted key answers", () => {
    expect(llmErrorCode({ status: 401 })).toBe("quota");
    expect(llmErrorCode({ status: 402 })).toBe("quota");
    expect(llmErrorCode({ status: 500 })).toBeUndefined();
  });
});

describe("formatLLMError", () => {
  it("replaces 401 with the quota hint", () => {
    expect(formatLLMError(new Error("401 无效的令牌 (request id: abc)"))).toBe(LLM_QUOTA_HINT);
    expect(formatLLMError({ status: 401, message: "Invalid token" })).toBe(LLM_QUOTA_HINT);
  });

  it("keeps other errors prefixed", () => {
    expect(formatLLMError(new Error("upstream 500"))).toBe("LLM error: upstream 500");
  });
});

import { describe, it, expect } from "vitest";
import { formatLLMError, isUnauthorizedLLMError, LLM_QUOTA_HINT } from "./errors.js";

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

describe("formatLLMError", () => {
  it("replaces 401 with the quota hint", () => {
    expect(formatLLMError(new Error("401 无效的令牌 (request id: abc)"))).toBe(LLM_QUOTA_HINT);
    expect(formatLLMError({ status: 401, message: "Invalid token" })).toBe(LLM_QUOTA_HINT);
  });

  it("keeps other errors prefixed", () => {
    expect(formatLLMError(new Error("upstream 500"))).toBe("LLM error: upstream 500");
  });
});

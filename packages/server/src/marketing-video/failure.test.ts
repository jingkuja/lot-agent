import { describe, expect, it } from "vitest";
import { ProviderError } from "@lot-agent/core";
import { GenerationError } from "../generation/errors.js";
import { marketingFailureCode, MarketingRunError } from "./failure.js";

describe("marketing failure codes", () => {
  it("classifies provider errors by code, phase and status", () => {
    const cases: [ProviderError, string][] = [
      [new ProviderError("generation", "create", "REAL_PERSON_REJECTED", { httpStatus: 400 }), "REAL_PERSON_REJECTED"],
      [new ProviderError("generation", "create", "CONNECT_ERROR"), "CONNECT_FAILED"],
      [new ProviderError("generation", "poll", "HTTP_ERROR", { httpStatus: 401 }), "MODEL_AUTH_REQUIRED"],
      [new ProviderError("kling-voice", "create", "HTTP_ERROR", { httpStatus: 403 }), "MODEL_AUTH_REQUIRED"],
      [new ProviderError("generation", "create", "HTTP_ERROR", { httpStatus: 402 }), "MODEL_QUOTA"],
      [new ProviderError("generation", "create", "HTTP_ERROR", { httpStatus: 429 }), "MODEL_RATE_LIMIT"],
      [new ProviderError("generation", "download", "TRANSPORT_ERROR"), "DOWNLOAD_INCOMPLETE"],
      [new ProviderError("generation", "poll", "TASK_FAILED"), "GENERATION_FAILED"],
      [new ProviderError("generation", "poll", "TRANSPORT_ERROR"), "STATUS_UNCONFIRMED"],
      [new ProviderError("generation", "poll", "INVALID_RESPONSE"), "STATUS_UNCONFIRMED"],
      [new ProviderError("generation", "create", "HTTP_ERROR", { httpStatus: 422 }), "GENERATION_FAILED"],
    ];
    for (const [error, code] of cases) expect(marketingFailureCode(error), error.message).toBe(code);
  });
  it("keeps typed codes and never reads message text", () => {
    expect(marketingFailureCode(new MarketingRunError("COMPOSITION_FAILED", "任意文字"))).toBe("COMPOSITION_FAILED");
    expect(marketingFailureCode(new GenerationError("TIMED_OUT", "generation timed out"))).toBe("TIMED_OUT");
    expect(marketingFailureCode(new GenerationError("MODEL_AUTH_REQUIRED", "缺少密钥"))).toBe("MODEL_AUTH_REQUIRED");
    // Text that the old client-side rules matched no longer decides anything.
    for (const text of ["HTTP 429 繁忙", "视频分段配置不完整", "generation timed out"]) expect(marketingFailureCode(new Error(text))).toBe("GENERATION_FAILED");
  });
});

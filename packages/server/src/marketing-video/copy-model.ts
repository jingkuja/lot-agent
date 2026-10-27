import { MARKETING_COPY_FALLBACK_MODEL, MARKETING_COPY_MODEL } from "@lot-agent/core/marketing-video";
import { MarketingTextError } from "./text.js";

/** Errors that mean the copy model itself failed. Cancellation, authorization and quota say nothing about the model. */
const MODEL_FAULTS = ["MARKETING_MODEL_UNAVAILABLE", "MARKETING_MODEL_BUSY", "MARKETING_TEXT_TIMEOUT", "MARKETING_TEXT_EMPTY",
  "MARKETING_TEXT_TRUNCATED", "MARKETING_TEXT_INVALID_JSON", "MARKETING_TEXT_INVALID_RESULT"];

export function copyModelFault(error: unknown) {
  return error instanceof MarketingTextError && MODEL_FAULTS.includes(error.code);
}

/** After the default copy model fails, new copy and storyboard requests use the fallback for `holdMs`,
 * then try the default again; another failure switches back for the same time. The failed request
 * itself is never resent. State is per process: the API server and the analysis worker switch on
 * their own failures. */
export class CopyModelSwitch {
  private until = 0;
  constructor(readonly primary: string, readonly fallback: string, private readonly holdMs: number, private readonly now = Date.now) {}

  current() { return this.now() < this.until ? this.fallback : this.primary; }

  /** Only a failure of the default model counts; one that started before an earlier switch does not extend it. */
  failed(model: string) {
    if (model !== this.primary || this.now() < this.until) return;
    this.until = this.now() + this.holdMs;
    console.warn("[marketing-copy] default model failed, switching", { failed: model, fallback: this.fallback, minutes: this.holdMs / 60_000 });
  }

  reset() { this.until = 0; }
}

export const marketingCopyModel = new CopyModelSwitch(MARKETING_COPY_MODEL, MARKETING_COPY_FALLBACK_MODEL, 30 * 60_000);

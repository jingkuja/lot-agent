import { MARKETING_COPY_FALLBACK_MODEL, MARKETING_COPY_LAST_RESORT_MODEL, MARKETING_COPY_MODEL } from "@lot-agent/core/marketing-video";
import { MarketingTextError } from "./text.js";

/** Errors that mean the copy model itself failed. Cancellation, authorization and quota say nothing about the model. */
const MODEL_FAULTS = ["MARKETING_MODEL_UNAVAILABLE", "MARKETING_MODEL_BUSY", "MARKETING_TEXT_TIMEOUT", "MARKETING_TEXT_EMPTY",
  "MARKETING_TEXT_TRUNCATED", "MARKETING_TEXT_INVALID_JSON", "MARKETING_TEXT_INVALID_RESULT"];

export function copyModelFault(error: unknown) {
  return error instanceof MarketingTextError && MODEL_FAULTS.includes(error.code);
}

/** After the model in use fails, new copy and storyboard requests move to the next model in `models`
 * for `holdMs`, then try the first one again; the last model is kept until then even if it fails too.
 * The failed request itself is never resent. State is per process: the API server and the analysis
 * worker switch on their own failures. */
export class CopyModelSwitch {
  private level = 0;
  private until = 0;
  constructor(readonly models: readonly string[], private readonly holdMs: number, private readonly now = Date.now) {}

  current() { return this.models[this.now() < this.until ? this.level : 0]!; }

  /** Only a failure of the model now in use counts; one that started before an earlier switch does not move it again. */
  failed(model: string) {
    const level = this.models.indexOf(model);
    if (model !== this.current() || level === this.models.length - 1) return;
    this.level = level + 1; this.until = this.now() + this.holdMs;
    console.warn("[marketing-copy] copy model failed, switching", { failed: model, next: this.models[this.level], minutes: this.holdMs / 60_000 });
  }

  reset() { this.level = 0; this.until = 0; }
}

export const marketingCopyModel = new CopyModelSwitch([MARKETING_COPY_MODEL, MARKETING_COPY_FALLBACK_MODEL, MARKETING_COPY_LAST_RESORT_MODEL], 30 * 60_000);

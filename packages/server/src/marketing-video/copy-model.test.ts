import { describe, expect, it } from "vitest";
import { CopyModelSwitch, copyModelFault } from "./copy-model.js";
import { MarketingTextError } from "./text.js";

describe("copy model switch", () => {
  it("uses the fallback for the hold time after the default fails, then tries the default again", () => {
    let now = 0;
    const models = new CopyModelSwitch(["kimi-k3.1-pro", "kimi-k3"], 30 * 60_000, () => now);
    expect(models.current()).toBe("kimi-k3.1-pro");
    models.failed("kimi-k3.1-pro");
    expect(models.current()).toBe("kimi-k3");
    now = 29 * 60_000;
    // A default request that started before the switch does not extend it; neither does a fallback failure.
    models.failed("kimi-k3.1-pro"); models.failed("kimi-k3");
    now = 30 * 60_000;
    expect(models.current()).toBe("kimi-k3.1-pro");
    models.failed("kimi-k3.1-pro");
    expect(models.current()).toBe("kimi-k3");
    now = 60 * 60_000;
    expect(models.current()).toBe("kimi-k3.1-pro");
    models.failed("deepseek-v4.1-flash");
    expect(models.current()).toBe("kimi-k3.1-pro");
  });

  it("moves to the last resort when the fallback also fails, and tries the default 30 minutes later", () => {
    let now = 0;
    const models = new CopyModelSwitch(["kimi-k3.1-pro", "kimi-k3", "deepseek-v4.1-flash"], 30 * 60_000, () => now);
    models.failed("kimi-k3.1-pro");
    now = 10 * 60_000;
    models.failed("kimi-k3");
    expect(models.current()).toBe("deepseek-v4.1-flash");
    // Late failures of earlier models and failures of the last resort keep the last resort until its time is up.
    now = 35 * 60_000;
    models.failed("kimi-k3.1-pro"); models.failed("kimi-k3"); models.failed("deepseek-v4.1-flash");
    expect(models.current()).toBe("deepseek-v4.1-flash");
    now = 40 * 60_000;
    expect(models.current()).toBe("kimi-k3.1-pro");
    // A fallback request that outlived its window does not move the default away.
    models.failed("kimi-k3");
    expect(models.current()).toBe("kimi-k3.1-pro");
    models.failed("kimi-k3.1-pro");
    expect(models.current()).toBe("kimi-k3");
    models.reset();
    expect(models.current()).toBe("kimi-k3.1-pro");
  });

  it("counts only failures of the model itself", () => {
    expect(copyModelFault(new MarketingTextError("", "MARKETING_MODEL_UNAVAILABLE"))).toBe(true);
    expect(copyModelFault(new MarketingTextError("", "MARKETING_TEXT_TRUNCATED"))).toBe(true);
    for (const code of ["MARKETING_TEXT_CANCELLED", "MARKETING_MODEL_AUTH", "MARKETING_MODEL_QUOTA", "MARKETING_USAGE_LIMIT"]) {
      expect(copyModelFault(new MarketingTextError("", code))).toBe(false);
    }
    expect(copyModelFault(new Error("other"))).toBe(false);
  });
});

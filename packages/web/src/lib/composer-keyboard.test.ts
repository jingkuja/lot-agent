import { describe, expect, it } from "vitest";
import { shouldSubmitComposer } from "./composer-keyboard.js";

describe("shouldSubmitComposer", () => {
  it("submits a plain Enter key", () => {
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: false })).toBe(true);
  });

  it("does not submit while an IME composition is active", () => {
    expect(shouldSubmitComposer(
      { key: "Enter", shiftKey: false, isComposing: true },
      true
    )).toBe(false);
  });

  it("uses the component composition state when the browser flag is missing", () => {
    expect(shouldSubmitComposer(
      { key: "Enter", shiftKey: false },
      true
    )).toBe(false);
  });

  it("recognizes legacy IME key events with keyCode 229", () => {
    expect(shouldSubmitComposer(
      { key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }
    )).toBe(false);
  });

  it("keeps Shift+Enter and non-Enter keys from submitting", () => {
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSubmitComposer({ key: "a", shiftKey: false })).toBe(false);
  });
});

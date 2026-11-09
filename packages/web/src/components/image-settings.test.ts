// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputBox, type InputBoxHandle } from "./InputBox.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); });

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

describe("image composer settings", () => {
  it("sends tiers without pixels, preserves image edits, and retains the selection across composer remounts", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const ref = createRef<InputBoxHandle>();
    const changeModel = vi.fn();
    const props = {
      ref, mode: "image" as const, selectedModel: "gpt-image-2.5-flare", onModelChange: changeModel,
      models: [
        { id: "gpt-image-2.5-flare", type: "image" as const, provider: "test" },
        { id: "gpt-image-2.5-sunburst", type: "image" as const, provider: "test" },
      ],
    };
    act(() => root!.render(createElement(InputBox, props)));
    act(() => button("图片参数").click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="宽度"]')).toBeNull();
    expect(document.querySelector('.input-box .model-picker')).toBeNull();
    act(() => button("4K").click());
    act(() => button("9:16").click());
    const range = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(range, "3");
      range.dispatchEvent(new Event("input", { bubbles: true }));
      range.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(ref.current?.getSettings()).toEqual({ resolution: "4K", ratio: "9:16", n: 3, quality: "auto" });
    expect(ref.current?.prepareImageSend().settings).toEqual(ref.current?.getSettings());
    const stored = { resolution: "2K", ratio: "4:3", size: "2048x1536", n: 2, quality: "high" };
    expect(ref.current?.prepareImageSend(stored)).toEqual({ settings: stored });
    expect(ref.current?.prepareImageSend({ size: "1536x1024" })).toEqual({ settings: { size: "1536x1024", n: 1, quality: "auto" } });
    act(() => button("旗舰").click());
    expect(changeModel).toHaveBeenLastCalledWith("gpt-image-2.5-sunburst");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => root!.render(null));
    act(() => root!.render(createElement(InputBox, props)));
    expect(ref.current?.getSettings()).toEqual({ resolution: "4K", ratio: "9:16", n: 3, quality: "auto" });
    act(() => button("图片参数").click());
    act(() => root!.render(createElement(InputBox, { ...props, disabled: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button("图片参数").disabled).toBe(true);
  });
});

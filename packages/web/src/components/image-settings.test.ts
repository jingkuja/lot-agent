// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputBox, type InputBoxHandle } from "./InputBox.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === text || item.textContent?.trim() === text);
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

describe("image composer settings", () => {
  it("waits for slow reference decoding and sends its ratio only once", async () => {
    let decode!: () => void;
    vi.stubGlobal("Image", class {
      naturalWidth = 1600;
      naturalHeight = 900;
      onload?: () => void;
      onerror?: () => void;
      set src(_url: string) { decode = () => this.onload?.(); }
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const send = vi.fn(async () => "accepted" as const);
    const ref = createRef<InputBoxHandle>();
    act(() => root!.render(createElement(InputBox, {
      ref, mode: "image", value: "product", onSend: send,
      attachment: { id: "slow", file: new File(["image"], "slow.png", { type: "image/png" }) },
    })));
    act(() => button("图片参数").click());
    act(() => button("智能").click());
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    const submit = document.querySelector<HTMLButtonElement>(".btn-send")!;
    await act(async () => { submit.click(); submit.click(); });
    expect(send).not.toHaveBeenCalled();
    await act(async () => { decode(); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ ratio: "16:9" })]));
  });

  it("passes no click event to the shared stop action", () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const stop = vi.fn();
    act(() => root!.render(createElement(InputBox, { mode: "image", disabled: true, onStop: stop })));
    act(() => document.querySelector<HTMLButtonElement>(".btn-stop")!.click());
    expect(stop).toHaveBeenCalledWith();
  });

  it("sends tiers without pixels, preserves image edits, and retains the selection across composer remounts", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const ref = createRef<InputBoxHandle>();
    const changeModel = vi.fn();
    const props = {
      ref, mode: "image" as const, selectedModel: null, onModelChange: changeModel,
      models: [
        { id: "linqu-image", type: "image" as const, provider: "test" },
        { id: "gpt-image-2.5-flare", type: "image" as const, provider: "test" },
        { id: "gpt-image-2.5-sunburst", type: "image" as const, provider: "test" },
      ],
    };
    act(() => root!.render(createElement(InputBox, props)));
    act(() => button("图片参数").click());
    expect(button("默认").getAttribute("aria-pressed")).toBe("true");
    expect(button("电商爆款").getAttribute("aria-pressed")).toBe("false");
    expect([...document.querySelectorAll(".image-model-card")].map((item) => item.getAttribute("aria-label"))).toEqual([
      "电商爆款", "默认", "旗舰",
    ]);
    expect(button("电商爆款").querySelector("small")?.textContent).toBe("复刻爆款，模特出镜无限制。");
    expect(button("默认").querySelector("small")?.textContent).toBe("快速高质量出图");
    expect(button("旗舰").querySelector("small")?.textContent).toBe("追求更高品质的细节。");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="宽度"]')).toBeNull();
    expect(document.querySelector('.input-box .model-picker')).toBeNull();
    act(() => button("4K").click());
    // 图片比例 shows one row (智能 … 4:3) until 更多; the section order is 清晰度, 图片比例, 模型, 质量.
    const ratios = () => [...document.querySelectorAll(".image-ratio-grid .seg")].map((item) => item.textContent?.trim());
    expect(ratios()).toEqual(["智能", "1:1", "3:2", "2:3", "3:4", "4:3"]);
    expect([...document.querySelectorAll(".media-section-title")].map((item) => item.textContent)).toEqual([
      "清晰度", "图片比例", "模型", "质量", "图片张数",
    ]);
    act(() => button("更多").click());
    expect(ratios()).toHaveLength(11);
    act(() => button("9:16").click());
    act(() => button("收起").click());
    // A choice from the hidden rows stays in view as the folded row's last place.
    expect(ratios()).toEqual(["智能", "1:1", "3:2", "2:3", "3:4", "9:16"]);
    const range = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(range, "3");
      range.dispatchEvent(new Event("input", { bubbles: true }));
      range.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(ref.current?.getSettings()).toEqual({ resolution: "4K", ratio: "9:16", n: 3, quality: "auto" });
    expect((await ref.current?.prepareImageSend())?.settings).toEqual(ref.current?.getSettings());
    const stored = { resolution: "2K", ratio: "4:3", size: "2048x1536", n: 2, quality: "high" };
    expect(await ref.current?.prepareImageSend(stored)).toEqual({ settings: stored });
    expect(await ref.current?.prepareImageSend({ size: "1536x1024" })).toEqual({ settings: { size: "1536x1024", n: 1, quality: "auto" } });
    act(() => button("旗舰").click());
    expect(changeModel).toHaveBeenLastCalledWith("gpt-image-2.5-sunburst");
    act(() => button("电商爆款").click());
    expect(changeModel).toHaveBeenLastCalledWith("linqu-image");
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

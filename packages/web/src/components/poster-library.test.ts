// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client.js";
import { PosterReferencePicker } from "./PosterReferencePicker.js";

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const click = async (text: string) => {
  const target = [...document.querySelectorAll("button")].find(button => button.textContent === text || button.getAttribute("aria-label") === text);
  expect(target).toBeDefined(); await act(async () => target!.click());
};
const search = (text: string) => act(() => {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

it("debounces searches, aborts stale requests, and resets pagination on search and category changes", async () => {
  vi.spyOn(api, "posterCategories").mockResolvedValue({ categories: ["食品", "家居"], orientations: true });
  const images = vi.spyOn(api, "posterImages").mockResolvedValue({ items: [], nextOffset: null });
  let resolveOld!: (value: { items: []; nextOffset: null }) => void;
  images.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  await act(async () => root.render(createElement(PosterReferencePicker, { selected: null, disabled: false, onChange: vi.fn() })));
  await click("选择爆款");
  await act(async () => vi.advanceTimersByTimeAsync(250));
  const oldSignal = images.mock.calls[0][2];
  search("t"); search("tea");
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(249)); expect(images).toHaveBeenCalledTimes(1);
  images.mockResolvedValueOnce({ items: [], nextOffset: 24 });
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(images).toHaveBeenLastCalledWith("食品", 0, expect.any(AbortSignal), "tea", "all");
  await act(async () => resolveOld({ items: [], nextOffset: null }));
  await click("加载更多"); await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(images).toHaveBeenLastCalledWith("食品", 24, expect.any(AbortSignal), "tea", "all");
  await click("家居"); await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(images).toHaveBeenLastCalledWith("家居", 0, expect.any(AbortSignal), "tea", "all");
  const select = document.querySelector<HTMLSelectElement>("select")!;
  act(() => { select.value = "portrait"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(images).toHaveBeenLastCalledWith("家居", 0, expect.any(AbortSignal), "tea", "portrait");
});

it("hides direction filtering for an old catalog without dimensions", async () => {
  vi.spyOn(api, "posterCategories").mockResolvedValue({ categories: ["食品"], orientations: false });
  vi.spyOn(api, "posterImages").mockResolvedValue({ items: [], nextOffset: null });
  await act(async () => root.render(createElement(PosterReferencePicker, { selected: null, disabled: false, onChange: vi.fn() })));
  await click("选择爆款"); expect(document.querySelector("select")).toBeNull();
  expect(document.querySelector('input[type="search"]')).not.toBeNull();
});

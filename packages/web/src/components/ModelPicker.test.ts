// @vitest-environment happy-dom
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client.js";
import { LanguageProvider } from "../i18n/index.js";
import { ModelPicker } from "./ModelPicker.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  { globle: 0, name: "deepseek-v4.1-flash" },
  { globle: 1, name: "linqu-v4.1-flash" },
])("displays $name and selects the original model ID for globle=$globle", async ({ globle, name }) => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(api, "getProductLinks").mockResolvedValue({ globle, webUrl: "", tokenhubUrl: "" });
  const id = "deepseek-v4.1-flash";
  const models = [id, "claude-sonnet-5-5", "gpt-5.4"].map((id) => ({ id, type: "llm" as const, provider: "tokenhub" }));
  const onChange = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(LanguageProvider, { children: createElement(ModelPicker, { models, value: id, onChange }) }));
    });
    const trigger = container.querySelector("button")!;
    expect(trigger.textContent).toBe(name);
    act(() => trigger.click());
    const search = document.querySelector<HTMLInputElement>(".model-search")!;
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(search, name);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const rows = document.querySelectorAll<HTMLButtonElement>(".model-row");
    expect(Array.from(rows, (row) => row.textContent)).toEqual([name]);
    act(() => rows[0].click());
    expect(onChange).toHaveBeenCalledWith(id);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

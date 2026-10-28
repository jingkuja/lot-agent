// @vitest-environment happy-dom
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client.js";
import { LanguageProvider } from "../i18n/index.js";
import { Login } from "./Login.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("login compliance information", () => {
  it.each([true, false, undefined])("uses the public visibility setting %s", async (showCompliance) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(api, "getProductLinks").mockResolvedValue({
      globle: 1, showCompliance, webUrl: "https://example.com", tokenhubUrl: "https://example.com",
    });
    vi.spyOn(api, "mode").mockResolvedValue({ managedRegistration: false } as Awaited<ReturnType<typeof api.mode>>);
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(LanguageProvider, { children: createElement(Login, { onLogin: () => {} }) }));
    });
    expect(container.querySelector(".login-compliance") !== null).toBe(showCompliance !== false);
    if (showCompliance !== false) {
      expect(container.textContent).toContain("2025156360");
      expect(container.textContent).toContain("20260779");
    }
    act(() => root.unmount());
  });
});

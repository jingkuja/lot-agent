// @vitest-environment happy-dom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client.js";
import { LanguageProvider, LanguageSelect } from "../i18n/index.js";
import { LOCALE_STORAGE_KEY, type Locale } from "../i18n/locale.js";
import { LegalModal } from "./LegalModal.js";

const roots: Root[] = [];
const address = "Flat/RM A, 12/F, ZJ 300 300, 300 Lockhart Road, Wan Chai, Hong Kong";
const company = "CLOUDDATA AI TECH CO., LIMITED（雲數智科有限公司）";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
});
afterEach(() => {
  act(() => { roots.splice(0).forEach(root => root.unmount()); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderLegal(globle: number | undefined, kind: "terms" | "privacy", locale?: Locale) {
  if (locale) localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  vi.spyOn(api, "getProductLinks").mockResolvedValue({ globle, webUrl: "https://example.com", tokenhubUrl: "https://example.com" });
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(LanguageProvider, { children: [
      createElement(LanguageSelect, { key: "language" }),
      createElement(LegalModal, { key: "legal", kind, onClose: () => {} }),
    ] }));
  });
  return container;
}

describe("legal documents by deployment configuration", () => {
  it.each([undefined, 0])("preserves the original documents for globle=%s despite a saved English preference", async globle => {
    for (const kind of ["terms", "privacy"] as const) {
      const container = await renderLegal(globle, kind, "en");
      expect(container.querySelector("h2")?.textContent).toBe(kind === "terms" ? "用户协议" : "隐私政策");
      expect(container.textContent).toContain("更新日期：2026年8月18日");
      expect(container.textContent).not.toContain("CLOUDDATA");
      expect(container.textContent).not.toContain("香港");
      expect(container.querySelector("select")).toBeNull();
      if (kind === "privacy") expect(container.textContent).toContain("请勿上传国家秘密");
    }
  });

  it.each([
    { locale: "zh" as const, terms: "服务条款", law: "香港特别行政区法律", privacy: "《个人资料（私隐）条例》（第486章）" },
    { locale: "en" as const, terms: "Terms of Service", law: "laws of the Hong Kong Special Administrative Region",
      privacy: "Personal Data (Privacy) Ordinance (Cap. 486)" },
    { locale: "id" as const, terms: "Ketentuan Layanan", law: "hukum Daerah Administratif Khusus Hong Kong",
      privacy: "Personal Data (Privacy) Ordinance (Cap. 486)" },
  ])("shows the Hong Kong entity and law in both $locale documents", async ({ locale, terms, law, privacy }) => {
    for (const kind of ["terms", "privacy"] as const) {
      const container = await renderLegal(1, kind, locale);
      expect(container.textContent).toContain(company);
      expect(container.textContent).toContain(address);
      expect(container.textContent).toContain("ZHENG YVHUI");
      expect(container.textContent).toContain("+852 5776 7174");
      expect(container.textContent).toContain(law);
      expect(container.textContent).not.toContain("2026年8月18日");
      if (kind === "terms") expect(container.querySelector("h2")?.textContent).toBe(terms);
      if (kind === "privacy") expect(container.textContent).toContain(privacy);
      const content = container.querySelector("article")!.textContent!;
      // International translations must not silently fall back to Chinese legal paragraphs.
      if (locale !== "zh") expect(content.replaceAll(company, "")).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("defaults to Indonesian and retains the Hong Kong entity when switching to Chinese", async () => {
    const container = await renderLegal(1, "terms");
    expect(container.querySelector("h2")?.textContent).toBe("Ketentuan Layanan");
    const select = container.querySelector("select")!;
    act(() => { select.value = "zh"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector("h2")?.textContent).toBe("服务条款");
    expect(container.textContent).toContain(company);
    expect(container.textContent).toContain(address);
    expect(container.textContent).toContain("香港特别行政区具有管辖权的法院");
    expect(container.textContent).toContain("个人资料查询负责人");
  });

  it("keeps the existing documents if public configuration cannot be loaded", async () => {
    vi.spyOn(api, "getProductLinks").mockRejectedValue(new Error("offline"));
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(LanguageProvider, {
        children: createElement(LegalModal, { kind: "terms", onClose: () => {} }),
      }));
    });
    expect(container.querySelector("h2")?.textContent).toBe("用户协议");
    expect(container.textContent).not.toContain("CLOUDDATA");
  });
});

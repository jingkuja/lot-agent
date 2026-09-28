import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client.js";
import { LOCALE_STORAGE_KEY, isInternational, resolveLocale, translate, type Locale } from "./locale.js";

const LanguageContext = createContext({
  locale: "zh" as Locale,
  enabled: false,
  setLocale: (_locale: Locale) => {},
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const [locale, updateLocale] = useState<Locale>("zh");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    void api.getProductLinks(controller.signal).then((config) => {
      if (!active) return;
      let saved: string | null = null;
      try { saved = localStorage.getItem(LOCALE_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
      setEnabled(isInternational(config.globle));
      updateLocale(resolveLocale(config.globle, saved));
    }).catch(() => { /* Older/offline servers keep the Chinese interface. */ })
      .finally(() => { window.clearTimeout(timeout); if (active) setReady(true); });
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, []);
  const setLocale = useCallback((next: Locale) => {
    const resolved = resolveLocale(enabled ? 1 : 0, next);
    updateLocale(resolved);
    if (enabled) {
      try { localStorage.setItem(LOCALE_STORAGE_KEY, resolved); } catch { /* Session-only selection. */ }
    }
  }, [enabled]);
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : locale;
    document.title = translate("借势智算", locale);
  }, [locale]);
  const value = useMemo(() => ({ locale, enabled, setLocale }), [locale, enabled, setLocale]);
  return <LanguageContext.Provider value={value}>{ready ? children : null}</LanguageContext.Provider>;
}

export function useI18n() {
  const context = useContext(LanguageContext);
  const t = useCallback(<T,>(source: T, values?: readonly unknown[]) => translate(source, context.locale, values), [context.locale]);
  return { ...context, t };
}

/** A native select remains keyboard-accessible in web and Electron. */
export function LanguageSelect() {
  const { locale, enabled, setLocale } = useI18n();
  if (!enabled) return null;
  return <select className="language-select" aria-label="Bahasa / Language / 语言" value={locale}
    onChange={(event) => setLocale(event.target.value as Locale)}>
    <option value="id">Indonesia</option>
    <option value="en">English</option>
    <option value="zh">中文</option>
  </select>;
}

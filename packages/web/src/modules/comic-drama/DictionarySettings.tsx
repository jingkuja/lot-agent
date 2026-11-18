import { useEffect, useRef, useState } from "react";
import { comicDictionaryDomains, type ComicDictionaryDomain, type ComicDictionaryEntry } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicLibraryApi } from "./library-api.js";
import { LibraryDialog, libraryError } from "./LibraryParts.js";
import { comicMaterialLabels } from "./MaterialLibrary.js";

const domainNames = {
  ...comicMaterialLabels, role: "角色定位", slot: "造型槽位", expression: "表情",
  framing: "景别", movement: "运镜", style: "画风", emotion: "台词情绪",
} as const;

export function DictionarySettings() {
  const { locale, t } = useI18n();
  const [domain, setDomain] = useState<ComicDictionaryDomain>("slot");
  const [entries, setEntries] = useState<ComicDictionaryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<ComicDictionaryEntry | "new" | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setEntries(null);
    setError("");
    void comicLibraryApi.dictionary(domain, controller.signal).then(rows => {
      if (!controller.signal.aborted) setEntries(rows);
    }).catch(reason => { if (!controller.signal.aborted) setError(libraryError(reason)); });
    return () => controller.abort();
  }, [domain, refresh]);
  const apply = async (operation: () => Promise<ComicDictionaryEntry[]>) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError("");
    try { setEntries(await operation()); }
    catch (reason) { setError(libraryError(reason)); }
    finally { writing.current = false; setBusy(false); }
  };
  const move = (from: number, to: number) => {
    if (!entries || to < 0 || to >= entries.length) return;
    const keys = entries.map(row => row.key);
    [keys[to], keys[from]] = [keys[from], keys[to]];
    void apply(() => comicLibraryApi.sort(domain, keys));
  };
  return <>
    <header className="comic-heading"><h1>{t("数据字典")}</h1>
      <button className="primary" disabled={busy || !entries} onClick={() => setDialog("new")}>＋ {t("添加字典条目")}</button>
    </header>
    <div className="comic-library-controls">
      <label>{t("字典领域")}<select disabled={busy} value={domain} onChange={event => setDomain(event.target.value as ComicDictionaryDomain)}>
        {comicDictionaryDomains.map(value => <option value={value} key={value}>{t(domainNames[value])}</option>)}
      </select></label>
    </div>
    {error && <div className="comic-error" role="alert">{t(error)}
      <button onClick={() => setRefresh(i => i + 1)}>{t("重新读取")}</button></div>}
    {!entries && !error && <p role="status">{t("加载中…")}</p>}
    <div className="comic-dictionary-list">
      {entries?.map((entry, index) => <article key={entry.key}>
        <div>
          <strong>{entry.labels[locale]}</strong> <code>{entry.key}</code>
          <small>{entry.system ? t("系统条目") : t("自定义条目")}{entry.inactive ? " · " + t("已停用") : ""}</small>
        </div>
        <div className="comic-actions">
          <button disabled={busy || index === 0} aria-label={t("上移 {0}", [entry.labels[locale]])} onClick={() => move(index, index - 1)}>{t("上移")}</button>
          <button disabled={busy || index === entries.length - 1} aria-label={t("下移 {0}", [entry.labels[locale]])}
            onClick={() => move(index, index + 1)}>{t("下移")}</button>
          {!entry.system && <button disabled={busy} onClick={() => setDialog(entry)}>{t("编辑")}</button>}
          <button disabled={busy} onClick={() => void apply(() => comicLibraryApi.editEntry(domain, entry.key, { inactive: !entry.inactive }))}>
            {t(entry.inactive ? "启用" : entry.system ? "隐藏" : "停用")}
          </button>
        </div>
      </article>)}
    </div>
    {dialog && <LibraryDialog title={t(dialog === "new" ? "添加字典条目" : "编辑字典条目")} submitLabel={t("保存")} close={() => setDialog(null)}
      save={async form => {
        const labels = { zh: String(form.get("zh") ?? "").trim(), en: String(form.get("en") ?? "").trim(), id: String(form.get("id") ?? "").trim() };
        const rows = dialog === "new" ? await comicLibraryApi.addEntry(domain, String(form.get("key") ?? "").trim(), labels)
          : await comicLibraryApi.editEntry(domain, dialog.key, { labels });
        setEntries(rows);
      }}>
      {dialog === "new" && <label>{t("英文键")}<input name="key" required autoFocus maxLength={64} pattern="[a-z][a-z0-9_]{0,63}" placeholder="custom_key" /></label>}
      <label>{t("中文名称")}<input name="zh" required maxLength={120} defaultValue={dialog === "new" ? "" : dialog.labels.zh} /></label>
      <label>{t("英文名称")}<input name="en" required maxLength={120} defaultValue={dialog === "new" ? "" : dialog.labels.en} /></label>
      <label>{t("印尼语名称")}<input name="id" required maxLength={120} defaultValue={dialog === "new" ? "" : dialog.labels.id} /></label>
    </LibraryDialog>}
  </>;
}

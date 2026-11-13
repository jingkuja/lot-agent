import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { useI18n } from "../i18n/index.js";

/** The desktop origin serves local files; shared links always use the configured public Web destination. */
export function imageShareUrl(base: string, token: string): string {
  const url = new URL(base);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !/^[a-f0-9]{48}$/.test(token)) throw new Error("Invalid share URL");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/share/${token}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function ImageShareControl({ url }: { url: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const locked = useRef(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setReady(false);
    setNotice("");
    void Promise.all([api.imageShare(url, controller.signal), api.getProductLinks(controller.signal)]).then(([share, product]) => {
      if (controller.signal.aborted) return;
      // Validate before exposing an action that publishes the asset.
      imageShareUrl(product.webUrl, "a".repeat(48));
      setToken(share.token); setBase(product.webUrl); setReady(true);
    }).catch(() => { if (!controller.signal.aborted) setNotice("分享暂不可用，请重试"); });
    return () => controller.abort();
  }, [open, url, attempt]);
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setNotice("");
    try { await action(); } catch { setNotice("分享操作失败，请重试"); }
    finally { locked.current = false; setBusy(false); }
  };
  return <div className="image-share-control">
    <button type="button" className="image-viewer-edit" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t("分享")}</button>
    {open && <div className="image-share-panel">
      <p>{t("分享当前图片，任何获得链接的人都可查看。撤销只关闭分享页，无法收回已下载的图片或原图链接。")}</p>
      {!ready && !notice && <span role="status">{t("读取中…")}</span>}
      {!ready && notice && <button type="button" onClick={() => setAttempt(value => value + 1)}>{t("重试")}</button>}
      {ready && (token ? <>
        <input readOnly value={imageShareUrl(base, token)} aria-label={t("分享链接")} onFocus={event => event.currentTarget.select()} />
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          try { await navigator.clipboard.writeText(imageShareUrl(base, token)); setNotice("链接已复制"); }
          catch { setNotice("请选中上方链接手动复制"); }
        })}>{t("复制链接")}</button>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          await api.revokeImageShare(token); setToken(null); setNotice("分享已撤销");
        })}>{t("撤销分享")}</button>
      </> : <button type="button" disabled={busy} onClick={() => void run(async () => {
        const share = await api.createImageShare(url); setToken(share.token);
      })}>{t("创建分享链接")}</button>)}
      {notice && <p role="status">{t(notice)}</p>}
    </div>}
  </div>;
}

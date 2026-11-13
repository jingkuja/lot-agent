import { useEffect, useState } from "react";
import { useI18n } from "../i18n/index.js";

type SharedImage = { title: string; url: string; mime: string };

/** Anonymous page: deliberately bypasses session bootstrap and sends no credentials. */
export function PublicImageShare({ token }: { token: string }) {
  const { t } = useI18n();
  const [share, setShare] = useState<SharedImage | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setShare(null); setStatus("loading");
    if (!/^[a-f0-9]{48}$/.test(token)) { setStatus("missing"); return; }
    void fetch(`/api/public/shares/${token}`, { signal: controller.signal, credentials: "omit", cache: "no-store" }).then(async response => {
      if (!response.ok) { if (!controller.signal.aborted) setStatus(response.status === 404 ? "missing" : "error"); return; }
      const result = await response.json() as SharedImage;
      if (controller.signal.aborted) return;
      setShare(result); setStatus("ready");
    }).catch(() => { if (!controller.signal.aborted) setStatus("error"); });
    return () => controller.abort();
  }, [token, attempt]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") setAttempt(value => value + 1); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  return <main className="public-image-share">
    <header><a href="/">灵渠claw</a><span>{t("分享的作品")}</span></header>
    {status === "loading" && <p role="status">{t("读取中…")}</p>}
    {status === "missing" && <p role="status">{t("作品不存在或分享已撤销")}</p>}
    {status === "error" && <div role="alert"><p>{t("作品暂时无法读取")}</p>
      <button type="button" onClick={() => setAttempt(value => value + 1)}>{t("重试")}</button></div>}
    {status === "ready" && share && <><h1>{share.title}</h1>
      {share.mime.startsWith("image/") ? <img src={share.url} alt={share.title} referrerPolicy="no-referrer" />
        : share.mime === "video/mp4" ? <video src={share.url} controls /> : null}
    </>}
  </main>;
}

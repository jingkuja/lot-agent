import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/index.js";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** A long request in progress: what is running and for how long. Text requests
 * (copy, storyboard, check, titles) end within the server's 300 s deadline. */
export function WaitStatus({ label, started, textRequest = true }: { label: string; started: number; textRequest?: boolean }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  return <div className="mv-wait">
    <progress aria-hidden />
    <p><strong role="status">{t(label)}…</strong><span>{t("已用时 {0}", [clock(seconds)])}</span></p>
    {textRequest && <p className="mv-wait-note">{t("AI 创作最长需要 5 分钟；可以离开此页面，结果会自动保存，无需重复提交。")}</p>}
  </div>;
}

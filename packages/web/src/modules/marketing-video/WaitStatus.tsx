import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/index.js";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** A long request in progress: what is running and for how long. Text requests
 * (copy, storyboard, check, titles) end within the server's 480 s deadline.
 * With `expectedSec` the bar fills over that time from `started` (a server time,
 * so a refresh resumes it) and stops short of full until the result arrives. */
export function WaitStatus({ label, started, textRequest = true, expectedSec, note }: {
  label: string; started: number; textRequest?: boolean; expectedSec?: number; note?: string;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const slow = !!expectedSec && seconds >= expectedSec;
  return <div className="mv-wait">
    {expectedSec
      ? <progress aria-label={t("处理进度")} max={expectedSec} value={Math.min(seconds, expectedSec * 0.95)} />
      : <progress aria-hidden />}
    <p><strong role="status">{t(label)}…</strong><span>{expectedSec
      ? t(slow ? "已用时 {0}，个别任务需要更多时间，请耐心等候" : "已用时 {0} / 预计 {1}", [clock(seconds), clock(expectedSec)])
      : t("已用时 {0}", [clock(seconds)])}</span></p>
    {note ? <p className="mv-wait-note">{t(note)}</p>
      : textRequest && <p className="mv-wait-note">{t("AI 创作最长需要 8 分钟；可以离开此页面，结果会自动保存，无需重复提交。")}</p>}
  </div>;
}

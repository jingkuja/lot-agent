import { useEffect, useState } from "react";
import { MARKETING_SNAPSHOT_LIMIT, type MarketingDraftSnapshot } from "@lot-agent/core/marketing-video";
import { request } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { errorMessage } from "./api.js";

const REASONS: Record<MarketingDraftSnapshot["reason"], string> = {
  copy: "AI 生成文案前", storyboard: "AI 修改分镜前", clear: "修改文案清空分镜前", restore: "恢复历史版本前",
};
const formatTime = (value: string, locale: string) =>
  new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));

/** Earlier copy and storyboard versions of the saved draft (assessment M04), listed once opened.
 * `version` reloads the list after each save while it is open. */
export function DraftHistory({ projectId, count, version, busy, onRestore }: {
  projectId: string; count: number; version: number; busy: boolean;
  onRestore(snapshot: MarketingDraftSnapshot, time: string): void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<MarketingDraftSnapshot[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    setError("");
    request<{ data: MarketingDraftSnapshot[] }>(`/marketing-videos/${projectId}/snapshots`)
      .then(result => { if (!stopped) setList(result.data); })
      .catch(e => { if (!stopped) setError(errorMessage(e)); });
    return () => { stopped = true; };
  }, [open, projectId, count, version]);
  return <details className="mv-history" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{t("历史版本（{0}）", [count])}</summary>
    <p className="mv-hint">{t("AI 生成文案、修改分镜和清空分镜前会自动保存一份，保留最近 {0} 份。恢复只替换文案、分镜和标题标签，不收费。",
      [MARKETING_SNAPSHOT_LIMIT])}</p>
    {error && <p className="mv-error" role="alert">{t(error)}</p>}
    {!list && !error && open && <p className="mv-hint" role="status">{t("正在加载…")}</p>}
    {list && <ol>{list.map((snapshot, index) => {
      const time = formatTime(snapshot.createdAt, locale);
      return <li key={snapshot.id}>
        <div><span>{time} · {t(REASONS[snapshot.reason])} · {snapshot.shots
          ? t("{0} 个分镜 · 共 {1} 秒", [snapshot.shots, snapshot.durationSec]) : t("没有分镜")}</span><p>{snapshot.excerpt}</p></div>
        <button type="button" disabled={busy} onClick={() => onRestore(snapshot, time)}>{t(index ? "恢复此版本" : "恢复上一版")}</button>
      </li>;
    })}</ol>}
  </details>;
}

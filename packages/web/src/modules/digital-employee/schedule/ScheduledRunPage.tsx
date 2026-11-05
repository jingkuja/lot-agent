import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n/index.js";
import { employeeApi } from "../api.js";
import { formatTime } from "../opportunities/OpportunityCard.js";
import type { ScheduleRun } from "../types.js";
import { REASON_LABELS, RUN_LABELS, TEMPLATE_LABELS } from "./labels.js";

export function runSummary(run: ScheduleRun, t: (text: string) => string): string {
  const status = t(RUN_LABELS[run.status] ?? run.status);
  return run.reason ? `${status} · ${t(REASON_LABELS[run.reason] ?? run.reason)}` : status;
}

/** The report a scheduled run left, or why it did not leave one. */
export function ScheduledRunPage({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { t, locale } = useI18n();
  const [run, setRun] = useState<ScheduleRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRun(null); setError(null);
    void employeeApi.getScheduleRun(runId)
      .then((next) => { if (live) setRun(next); })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "读取失败"); });
    return () => { live = false; };
  }, [runId]);

  const report = run?.report;
  return <div className="de-page de-work-log de-work-detail">
    <header className="de-employee-page-head">
      <nav aria-label={t("工作记录")}><button type="button" className="de-text-button" onClick={onBack}>{t("返回")}</button></nav>
      <h1>{run ? t(TEMPLATE_LABELS[run.template]) : t("工作记录")}</h1>
    </header>
    {error && <div className="de-inline-error" role="alert"><span>{t(error)}</span></div>}
    {!run && !error && <div className="de-state">{t("加载中…")}</div>}
    {run && <article className="de-work-run">
      <header>
        <strong>{formatTime(run.scheduledFor, locale)}</strong>
        <small>{runSummary(run, t)}</small>
      </header>
      {report && <p className="de-work-summary">{report.summary}</p>}
      {report && report.items.length > 0 && <ul className="de-report-items">
        {report.items.map((item) => <li key={item.title}><strong>{item.title}</strong><p>{item.body}</p></li>)}
      </ul>}
      {report?.question && <p className="de-work-question">{report.question}</p>}
    </article>}
  </div>;
}
